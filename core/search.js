/**
 * 搜索引擎（完全重写版）
 *
 * 核心原则：
 *   1. 每步操作后验证结果
 *   2. 暂停/停止随时响应
 *   3. 不盲目重试
 *   4. 日志清晰记录每步状态
 */

const { getDouyinView } = require('../main/window');
const human = require('./humanBehavior');
const dom = require('./domUtils');
const videoProcessor = require('./videoProcessor');
const scheduler = require('./scheduler');
const robustClick = require('./robustClick');
const { getLogger } = require('./logger');
const { getCDPInterceptor } = require('../main/window');
const { getStateMachine, STATES } = require('./stateMachine');
const { getErrorAnalyzer, CATEGORIES, SEVERITY } = require('./errorAnalyzer');
const { getRecoveryManager } = require('./recovery');

const logger = getLogger('SearchEngine');

let searchRunning = false;
let searchPaused = false;
let logCallback = null;
let currentTask = null;

function checkRunning() { return searchRunning; }
function isRunning() { return searchRunning; }
function isPaused() { return searchPaused; }

function stopSearch() {
  searchRunning = false;
  searchPaused = false;
  if (currentTask) currentTask.stopped = true;
  log('🛑 搜索已停止');
  const state = getStateMachine();
  if (state.current === STATES.SEARCHING) {
    state.transition(STATES.IDLE, { phase: 'stopped' });
  }
}

function pauseSearch() {
  if (!searchRunning) return;
  searchPaused = !searchPaused;
  const state = getStateMachine();
  if (searchPaused) {
    state.transition(STATES.PAUSED, { phase: 'user_paused' });
  } else {
    state.transition(STATES.SEARCHING, { phase: 'resumed' });
  }
  log(searchPaused ? '⏸ 暂停' : '▶ 继续');
}

// ========== 可中断等待 ==========

async function wait(min, max) {
  const total = max ? rand(min, max) : min;
  const step = 300;
  for (let t = 0; t < total; t += step) {
    if (!searchRunning) return false;
    if (searchPaused) {
      log('⏸ 已暂停');
      while (searchPaused) { await sleep(300); if (!searchRunning) return false; }
      log('▶ 已恢复');
    }
    await sleep(step);
  }
  return true;
}

// ========== 主流程 ==========

async function startSearch(params, onLog, onResult, onProgress) {
  if (searchRunning) return;
  searchRunning = true;
  searchPaused = false;
  logCallback = onLog;

  // 规范化 keywords 参数：支持 keyword(字符串) / keywords(数组/字符串)
  if (!params.keywords) {
    params.keywords = params.keyword ? (Array.isArray(params.keyword) ? params.keyword : [params.keyword]) : [];
  } else if (typeof params.keywords === 'string') {
    params.keywords = [params.keywords];
  }

  const task = { params, processedIds: new Set(), stopped: false, matchedTotal: 0 };
  currentTask = task;
  scheduler.registerSearch(params);

  // 状态机：进入 SEARCHING
  getStateMachine().transition(STATES.SEARCHING, {
    phase: 'starting',
    taskId: `search_${Date.now()}`,
    taskDesc: params.keywords.length > 0 ? params.keywords.join(',') : '搜索'
  });

  const isQuantityMode = params.sortEnabled;
  log(`🚀 启动 [${isQuantityMode ? '数量' : '时间'}模式] 关键词: ${params.keywords.join(', ')}`);

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('❌ 浏览器未就绪'); return; }
    const wc = view.webContents;

    // 检查登录
    const body = await js(wc, 'document.body.innerText.substring(0,300)') || '';
    if (body.includes('登录') && body.length < 100) {
      log('请登录抖音...');
      for (let i = 0; i < 120; i++) {
        if (!await wait(3000)) return;
        const b = await js(wc, 'document.body.innerText.substring(0,300)') || '';
        if (!b.includes('登录') || b.length > 100) { log('✅ 登录成功'); break; }
      }
    }

    // 检查验证码
    if (await dom.hasCaptcha(view)) {
      log('⚠️ 验证码！请手动完成');
      while (await dom.hasCaptcha(view) && searchRunning) await wait(3000);
      log('✅ 验证码已通过');
    }

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const keywords = params.keywords || [];
    const commentHours = params.commentHours || 60;
    const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 3600;

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!searchRunning) break;
      const kw = keywords[kwIdx];
      log(`\n━━━ [${kwIdx+1}/${keywords.length}] ${kw} ━━━`);

      // 搜索
      const searchOk = await doSearch(view, kw);
      if (!searchOk) { log('❌ 搜索失败'); continue; }

      // 切换视频标签
      log('切换视频标签...');
      await clickTab(view, '视频');
      await wait(2000, 3000);

      // 筛选
      if (isQuantityMode && (params.sortMode !== 'default' || params.filterTime !== '0')) {
        log('筛选...');
        await doFilter(view, params);
      }

      // 视频循环
      const target = isQuantityMode ? (params.maxVideos || 10) : 999;
      let count = 0, fails = 0, scrollTry = 0, sincePause = 0, pauseAfter = rand(2, 5);

      while (searchRunning && count < target) {
        const videos = await dom.scanVideoLinks(view);
        const unprocessed = videos.filter(v => !task.processedIds.has(v.aid));

        if (unprocessed.length === 0) {
          scrollTry++;
          if (scrollTry > 10) { log('无更多视频'); break; }
          log(`滚动加载 ${scrollTry}/10...`);
          await human.mouseScroll(wc, 'down', 3);
          await wait(2000, 3000);
          continue;
        }
        scrollTry = 0;

        const v = unprocessed[0];
        task.processedIds.add(v.aid);
        count++;
        log(`[${count}/${target}] 视频 ${v.aid}`);

        // 每次处理视频前重新获取CDP实例（防止CDP重建后引用过期）
        let cdp = getCDPInterceptor();
        if (!cdp) {
          // CDP实例丢失，尝试重新启动
          log('  ⚠ CDP实例丢失，尝试恢复...');
          try {
            const { ensureCDPStarted } = require('../main/window');
            ensureCDPStarted(view);
            await sleep(1000, 2000);
            cdp = getCDPInterceptor();
            if (cdp) log('  ✅ CDP已恢复');
            else log('  ❌ CDP恢复失败，将仅使用DOM采集');
          } catch(e) {
            log('  ❌ CDP恢复异常: ' + e.message);
          }
        }

        const result = await videoProcessor.processVideo({
          view, aid: v.aid,
          keywords: { intent: intentKw, garbage: garbageKw },
          cdp,
          shouldContinue: () => searchRunning && !task.stopped,
          onResult,
          onLog: log,
          maxComments: params.maxComments || 200,
          onProgress: (info) => {
            if (typeof onProgress === 'function') {
              try {
                onProgress({
                  ...info,
                  videoIndex: count,
                  videoTotal: target,
                  matchedTotal: task.matchedTotal
                });
              } catch (_) {}
            }
          },
          cutoffTs
        });

        if (result.skipped) { fails++; log(`  跳过: ${result.skipped}`); }
        else { fails = 0; task.matchedTotal += result.matched; log(`  ✅ 命中:${result.matched}`); }

        // 命中后模拟深度阅读：随机长停顿5-20s，模拟真人仔细查看匹配内容
        if (!result.skipped && result.matched > 0) {
          const deepPause = rand(5, 20);
          log(`  📖 深度阅读 ${deepPause}s`);
          if (!await wait(deepPause * 1000)) break;
        }

        if (fails >= 3) {
          fails = 0;
          if (await dom.hasCaptcha(view)) {
            log('⚠️ 验证码！请手动完成');
            while (await dom.hasCaptcha(view) && searchRunning) await wait(3000);
          }
        }

        // 随机暂停
        sincePause++;
        if (sincePause >= pauseAfter) {
          const sec = rand(10, 90);
          log(`⏸ 暂停 ${sec}s`);
          if (!await wait(sec * 1000)) break;
          sincePause = 0;
          pauseAfter = rand(2, 5);
        }
      }
    }

    log(`✅ 完成！共 ${task.matchedTotal} 条意向`);
  } catch (e) {
    // 错误分析 + 自动恢复
    const analyzed = getErrorAnalyzer().analyze(e, { phase: 'search_loop', task: 'search' });
    log(`❌ [${analyzed.category}] ${analyzed.message} → ${analyzed.suggestion}`);
    getStateMachine().setError(analyzed.message, { category: analyzed.category });
    if (analyzed.severity === SEVERITY.FATAL) {
      getRecoveryManager().autoRecover(analyzed, { phase: 'search' }).catch(() => {});
    }
  } finally {
    searchRunning = false;
    searchPaused = false;
    currentTask = null;
    scheduler.notifySearchDone();
    const state = getStateMachine();
    if (state.current === STATES.SEARCHING || state.current === STATES.PAUSED) {
      state.transition(STATES.IDLE, { phase: 'completed' });
    }
  }
}

// ========== 搜索操作 ==========

async function doSearch(view, keyword) {
  const wc = view.webContents;

  // 1. 先移动鼠标到搜索框附近（模拟真人视线跟随）
  const searchPos = await js(wc, `(function(){
    const e = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);

  if (searchPos) {
    await human.mouseMove(wc, searchPos.x, searchPos.y);
    await sleep(200, 400);
  }

  // 2. 用 JS 直接聚焦搜索框
  const focused = await js(wc, `(function(){
    const e = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
    if (!e) return false;
    e.focus(); e.click(); return true;
  })()`);

  if (!focused) { log('  ❌ 搜索框未找到'); return false; }
  await sleep(300, 600);  // 聚焦后短暂停顿（模拟用户准备输入）

  // 3. 清空已有内容
  await js(wc, `(function(){
    const e = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
    if (e) e.select();
  })()`);
  await sleep(100, 200);
  await human.keyPress(wc, 'Backspace');
  await sleep(200, 400);

  // 4. 模拟IME输入（insertText模拟中文输入法选词完成）
  // 真人节奏：思考→输入→检查→确认
  await sleep(300, 600);  // 输入前思考时间
  await wc.insertText(keyword);
  await sleep(500, 1200);  // 输入后检查时间（真人会看一眼输入的内容）
  log(`  ✓ 输入: ${keyword}`);

  // 5. 关闭下拉菜单
  await robustClick.closePopover(view);
  await sleep(500, 800);

  // 6. 点击搜索按钮
  const btnPos = await js(wc, `(function(){
    const btn = document.querySelector('[data-e2e="searchbar-button"]');
    if (btn) {
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    }
    return null;
  })()`);
  if (btnPos) {
    // 先移动鼠标到搜索按钮（模拟真人移动视线）
    await human.mouseMove(wc, btnPos.x, btnPos.y);
    await sleep(200, 400);
    await human.mouseClick(wc, btnPos.x, btnPos.y);
    log(`  ✓ 点击搜索按钮 (${btnPos.x},${btnPos.y})`);
  } else {
    log('  搜索按钮未找到，尝试 Enter');
    await human.keyPress(wc, 'Enter');
  }
  await sleep(6000, 8000);

  // 7. 验证
  const url = await js(wc, 'location.href') || '';
  if (!url.includes('search')) {
    log('  搜索未生效，回车重试...');
    await human.keyPress(wc, 'Enter');
    await sleep(5000, 7000);
    const url2 = await js(wc, 'location.href') || '';
    if (!url2.includes('search')) { log(`  ❌ 失败`); return false; }
  }
  log('  ✓ 搜索页');

  if (await dom.hasCaptcha(view)) {
    log('  ⚠️ 验证码！');
    while (await dom.hasCaptcha(view) && searchRunning) await wait(3000);
  }
  return true;
}

// ========== 点击标签 ==========

async function clickTab(view, tabName) {
  // 顶部 tab 是已知危险区（相邻 tab 文本相似：综合/视频/用户/直播）
  // 必须用 robustClick.clickTopTab 严格定位
  const result = await robustClick.clickTopTab(view, tabName);
  if (result.success) {
    log(`  ✓ 点击TAB: ${tabName} @(${result.x},${result.y}) [${result.strategy}]`);
  } else {
    log(`  ❌ TAB未找到: ${tabName} (${result.error})`);
  }
  return result.success;
}

// ========== 筛选 ==========

/**
 * 抖音搜索页的"筛选"按钮：纯 hover（mouseenter）触发下拉面板
 * 不能直接 click（会跳到非筛选的下拉）
 * 选择完后再 click 该按钮可关闭
 *
 * 按钮特征（多版页面适配）：
 *   - 文本严格 = "筛选"（可能是叶子节点 span/div）
 *   - 也可能在父节点上（含子元素图标 + 文字）
 *   - 位置：搜索结果顶部工具栏，y 通常 60-150 之间
 *
 * 找到按钮后用 mouseHover（缓慢靠近+悬停）触发面板
 */
async function doFilter(view, params) {
  const wc = view.webContents;

  // === 1. 稳健定位筛选按钮 ===
  const fp = await _findFilterButton(wc);
  if (!fp) { log('  ⚠ 筛选按钮未找到'); return; }
  log(`  ✓ 筛选按钮 @(${fp.x},${fp.y}) selector=${fp.selector || ''}`);

  // === 2. 悬停打开面板（不是 click！） ===
  // 真人节奏：mouseMove 缓慢接近 + 悬停 800-1500ms
  await human.mouseHover(wc, fp.x, fp.y, 60, 30, 1200);

  // 等待面板出现
  const panelReady = await _waitFilterPanel(wc, 3000);
  if (!panelReady) {
    log('  ⚠ 筛选面板未出现，重试 hover');
    // 重试一次：再 hover
    await human.mouseHover(wc, fp.x, fp.y, 60, 30, 1200);
    const retry = await _waitFilterPanel(wc, 2500);
    if (!retry) {
      log('  ❌ 筛选面板二次重试仍未出现');
      return;
    }
  }
  log('  ✓ 筛选面板已展开');

  // === 3. 选择排序 ===
  const sortMap = { likes: '最多点赞', newest: '最新发布' };
  if (params.sortMode && sortMap[params.sortMode]) {
    const r = await _clickFilterOptionInPanel(view, sortMap[params.sortMode]);
    if (r.success) log(`  ✓ 排序: ${sortMap[params.sortMode]} @(${r.x},${r.y})`);
    else log(`  ❌ 排序未找到: ${sortMap[params.sortMode]} (${r.error})`);
    await sleep(1500, 2500);
  }

  // === 4. 选择时间 ===
  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (params.filterTime && timeMap[params.filterTime]) {
    const r = await _clickFilterOptionInPanel(view, timeMap[params.filterTime]);
    if (r.success) log(`  ✓ 时间: ${timeMap[params.filterTime]} @(${r.x},${r.y})`);
    else log(`  ❌ 时间未找到: ${timeMap[params.filterTime]} (${r.error})`);
    await sleep(1500, 2500);
  }

  // === 5. 关闭面板：再次 hover + click 筛选按钮（用户指定的方式） ===
  // 先把鼠标移开，触发 mouseLeave，再 hover 回筛选按钮
  await human.mouseMove(wc, 200, 200);
  await sleep(200, 300);
  await human.mouseHover(wc, fp.x, fp.y, 60, 30, 600);
  await sleep(200, 300);
  // 点击筛选按钮关闭
  try {
    await human.humanClick(wc, fp.x, fp.y);
    log('  ✓ 已点击筛选按钮关闭面板');
  } catch (e) {
    log('  ⚠ click 关闭失败，回退 ESC: ' + e.message);
    await robustClick.closePopover(view);
  }
  log('  ✓ 筛选已应用');
  await sleep(1500, 2500);
}

/**
 * 稳健定位筛选按钮 - 多策略降级
 * 策略：
 *   1. 叶子节点文本严格 == "筛选"
 *   2. 含子元素的容器，文本去空白后 == "筛选"
 *   3. 通过 data-e2e / class 名含 filter
 *   4. 通过 aria-label 含"筛选"
 */
async function _findFilterButton(wc) {
  // 统一策略：遍历所有元素，收集文本含"筛选"的候选，按精确匹配+面积排序
  // 实测 DOM: <div class="jjU9T0dQ">筛选<span class="QfeM8ow3">筛选</span></div> @ (750,79) 54x26
  const r = await js(wc, `(function(){
    const candidates = [];
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText || el.textContent || '').trim();
      if (!t.includes('筛选')) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.x < 50 || r.x > window.innerWidth) continue;
      if (r.y < 30 || r.y > 300) continue;
      const area = r.width * r.height;
      const isExact = t === '筛选';
      candidates.push({
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
        area,
        isExact,
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === 'string' ? el.className.substring(0, 80) : '',
        source: isExact ? 'exact_text' : 'includes_text'
      });
    }
    // 排序：精确匹配优先，面积从小到大（最小 = 最精确的按钮）
    candidates.sort((a, b) => {
      if (a.isExact !== b.isExact) return a.isExact ? -1 : 1;
      return a.area - b.area;
    });
    return candidates[0] || null;
  })()`);
  return r;
}

/**
 * 等待筛选面板出现 - 通过检测面板内典型文本"综合"/"最新发布"等
 */
async function _waitFilterPanel(wc, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await js(wc, `(function(){
      // 检测特征：包含"综合"/"最新发布"/"最多点赞"等
      const tokens = ['综合', '最新发布', '最多点赞', '一天内', '一周内', '半年内', '筛选'];
      const all = document.querySelectorAll('*');
      let dropdown = null;
      for (const el of all) {
        if (el.children.length > 5) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        // 面板一般在 y > 50 且宽度 < 400（窄面板）
        if (r.y < 50 || r.x < 200) continue;
        if (r.width > 400 || r.height > 600) continue;
        const t = (el.innerText || el.textContent || '').trim();
        let hits = 0;
        for (const tok of tokens) if (t.includes(tok)) hits++;
        if (hits >= 2) {
          dropdown = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), hits };
          break;
        }
      }
      return dropdown;
    })()`);
    if (r) return r;
    await sleep(150, 220);
  }
  return null;
}

/**
 * 在筛选面板内点击指定选项
 * 严格限定搜索范围为面板 DOM（避免误中顶部 tab）
 */
async function _clickFilterOptionInPanel(view, text) {
  const wc = view.webContents;
  // 先在面板内查找
  const r = await js(wc, `(function(){
    const tokens = ['综合', '最新发布', '最多点赞', '一天内', '一周内', '半年内', '筛选'];
    const all = document.querySelectorAll('*');
    let panel = null;
    for (const el of all) {
      if (el.children.length > 5) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.y < 50 || r.x < 200) continue;
      if (r.width > 400 || r.height > 600) continue;
      const t = (el.innerText || el.textContent || '').trim();
      let hits = 0;
      for (const tok of tokens) if (t.includes(tok)) hits++;
      if (hits >= 2) { panel = el; break; }
    }
    if (!panel) return { success: false, error: 'panel_not_found' };

    // 在 panel 内精确找 text
    for (const el of panel.querySelectorAll('*')) {
      const t = (el.innerText || el.textContent || '').trim();
      if (t === ${JSON.stringify(text)}) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        return {
          success: true,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height)
        };
      }
    }
    // 退化：includes 匹配
    for (const el of panel.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const t = (el.innerText || el.textContent || '').trim();
      if (t.includes(${JSON.stringify(text)})) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        return {
          success: true,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height)
        };
      }
    }
    return { success: false, error: 'option_not_in_panel' };
  })()`);

  if (!r || !r.success) return r || { success: false, error: 'unknown' };
  // 真人点击
  await human.humanClick(wc, r.x, r.y);
  return r;
}

// ========== 工具 ==========

async function js(wc, s) { try { return await wc.executeJavaScript(s); } catch(_) { return null; } }
function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }
function sleep(a, b) { const ms = b ? rand(a, b) : a; return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

module.exports = { startSearch, stopSearch, pauseSearch, isRunning, isPaused };
