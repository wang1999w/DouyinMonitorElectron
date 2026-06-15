/**
 * 搜索引擎（严格遵循老版本流程 + 每步状态反馈）
 *
 * 核心原则：
 *   1. 每步操作都有日志输出当前状态
 *   2. 暂停/停止在每个 sleep 间隔检查
 *   3. 评论检测用多种选择器
 *   4. 操作失败时记录原因，不盲目继续
 */

const { getDouyinView, getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const dom = require('./domUtils');
const videoProcessor = require('./videoProcessor');
const scheduler = require('./scheduler');
const { getLogger } = require('./logger');

const logger = getLogger('SearchEngine');

let searchRunning = false;
let searchPaused = false;
let logCallback = null;
let currentTask = null;

function checkRunning() { return searchRunning; }

function stopSearch() {
  searchRunning = false;
  if (currentTask) currentTask.stopped = true;
  searchPaused = false;
  log('🛑 搜索已停止');
}

function pauseSearch() {
  if (searchRunning) {
    searchPaused = !searchPaused;
    log(searchPaused ? '⏸ 搜索已暂停' : '▶ 搜索已继续');
  }
}

function isRunning() { return searchRunning; }

// ========== 可中断的 sleep ==========

async function interruptibleSleep(ms) {
  const step = 500;
  for (let t = 0; t < ms; t += step) {
    if (!searchRunning) return false;
    if (searchPaused) {
      while (searchPaused && searchRunning) await sleep(300);
      if (!searchRunning) return false;
    }
    await sleep(step);
  }
  return true;
}

// ========== 主流程 ==========

async function startSearch(params, onLog, onResult) {
  if (searchRunning) { log('已有任务在运行'); return; }
  searchRunning = true;
  searchPaused = false;
  logCallback = onLog;

  const task = {
    params, processedIds: new Set(), stopped: false,
    matchedTotal: 0, cdpTotal: 0, domTotal: 0
  };
  currentTask = task;
  scheduler.registerSearch(params);

  const isQuantityMode = params.sortEnabled;
  log(`🚀 搜索任务启动 [${isQuantityMode ? '数量模式' : '时间模式'}]`);

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('❌ 浏览器未就绪'); return; }
    const wc = view.webContents;

    // ===== 检查登录 =====
    const body = await js(wc, 'document.body.innerText.substring(0,300)') || '';
    if (body.includes('登录') && body.length < 100) {
      log('⏳ 等待登录...');
      for (let i = 0; i < 120; i++) {
        if (!await interruptibleSleep(3000)) return;
        const b = await js(wc, 'document.body.innerText.substring(0,300)') || '';
        if (!b.includes('登录') || b.length > 100) { log('✅ 登录成功'); break; }
      }
    }

    // ===== 检查验证码 =====
    if (await dom.hasCaptcha(view)) {
      log('⚠️ 验证码！请手动完成...');
      while (await dom.hasCaptcha(view) && searchRunning) { await interruptibleSleep(3000); }
      log('✅ 验证码已通过');
    }

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const keywords = params.keywords || [];
    const commentHours = params.commentHours || 60;
    const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 60;
    const cdp = getCDPInterceptor();

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!searchRunning) break;
      const kw = keywords[kwIdx];
      log(`\n━━━ [${kwIdx+1}/${keywords.length}] 关键词: ${kw} ━━━`);

      // ===== 输入关键词并搜索 =====
      const searchOk = await doSearch(view, kw, task);
      if (!searchOk) { log('❌ 搜索失败'); continue; }

      // ===== 切换视频标签 =====
      log('📋 切换视频标签...');
      await clickText(view, '视频');
      await interruptibleSleep(2000, 3000);

      // ===== 应用筛选 =====
      if (isQuantityMode && (params.sortMode !== 'default' || params.filterTime !== '0')) {
        log('🔍 应用筛选...');
        await doFilter(view, params);
      }

      // ===== 视频处理循环 =====
      const target = isQuantityMode ? (params.maxVideos || 10) : Infinity;
      let count = 0;
      let fails = 0;
      let scrollTry = 0;
      let sincePause = 0;
      let pauseAfter = rand(1, 3);

      while (searchRunning && count < target) {
        // 扫描视频
        const videos = await dom.scanVideoLinks(view);
        const unprocessed = videos.filter(v => !task.processedIds.has(v.aid));

        if (unprocessed.length === 0) {
          log('  滚动加载更多...');
          await human.mouseScroll(wc, 'down', 3);
          await interruptibleSleep(2000, 3000);
          scrollTry++;
          if (scrollTry > 10) { log('  无更多视频'); break; }
          continue;
        }
        scrollTry = 0;

        const v = unprocessed[0];
        count++;
        log(`\n━━━ [${count}/${target}] 视频 ${v.aid} ━━━`);

        // 处理视频
        const result = await videoProcessor.processVideo({
          view, aid: v.aid,
          keywords: { intent: intentKw, garbage: garbageKw },
          cdp,
          shouldContinue: () => searchRunning && !task.stopped,
          onResult,
          cutoffTs
        });

        if (result.skipped) {
          fails++;
          if (fails >= 3) { log('  连续3次失败'); fails = 0; }
          continue;
        }

        fails = 0;
        task.processedIds.add(v.aid);
        task.matchedTotal += result.matched;

        // 随机暂停（可中断）
        sincePause++;
        if (sincePause >= pauseAfter) {
          const sec = rand(15, 60);
          log(`⏸ 随机暂停 ${sec}s...`);
          if (!await interruptibleSleep(sec * 1000)) break;
          sincePause = 0;
          pauseAfter = rand(1, 3);
        }
      }
    }

    log(`\n✅ 搜索完成！共 ${task.matchedTotal} 条意向`);
  } catch (e) {
    log(`❌ 搜索异常: ${e.message}`);
  } finally {
    searchRunning = false;
    searchPaused = false;
    currentTask = null;
    scheduler.notifySearchDone();
  }
}

// ========== 搜索操作 ==========

async function doSearch(view, keyword, task) {
  const wc = view.webContents;

  // 关闭下拉菜单
  await human.mouseClick(wc, rand(600, 800), rand(400, 600));
  await sleep(500, 800);

  // 找搜索框
  const si = await dom.findSearchInput(view);
  if (!si) {
    log('  ❌ 搜索框未找到');
    return false;
  }
  log(`  搜索框: (${Math.round(si.x)},${Math.round(si.y)}) [${si.strategy}]`);

  // 点击搜索框
  await human.mouseClick(wc, si.x, si.y + 8);
  await sleep(400, 600);

  // 输入关键词
  await js(wc, `(function(){
    const e = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
    if (!e) return;
    e.focus();
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(e,'${keyword.replace(/'/g,"\\'")}');
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await sleep(500, 800);

  const val = await js(wc, `document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]')?.value||''`);
  log(`  输入: "${val}"`);

  // 点击搜索按钮
  const btn = await dom.findSearchButton(view);
  if (btn) {
    await human.mouseClick(wc, btn.x, btn.y);
    log(`  ✓ 搜索按钮点击 [${btn.strategy}]`);
  } else {
    log('  搜索按钮未找到，按回车');
    await human.keyPress(wc, 'Enter');
  }

  await interruptibleSleep(5000, 7000);

  // 验证
  const url = await js(wc, 'location.href') || '';
  const isSearch = url.includes('search');
  log(`  验证: ${isSearch ? '✓ 搜索页' : '✗ 未跳转'} (${url.substring(0, 50)})`);

  // 验证码
  if (await dom.hasCaptcha(view)) {
    log('  ⚠️ 验证码！');
    while (await dom.hasCaptcha(view) && searchRunning) { await interruptibleSleep(3000); }
  }

  return isSearch;
}

// ========== 筛选 ==========

async function doFilter(view, params) {
  const wc = view.webContents;
  const fp = await findText(view, '筛选');
  if (!fp) { log('  筛选按钮未找到'); return; }

  await human.mouseHover(wc, fp.x, fp.y, 50, 20, 2000);
  await sleep(2000, 2500);

  const sortMap = { likes: '最多点赞', newest: '最新发布' };
  if (params.sortMode && sortMap[params.sortMode]) {
    const p = await findText(view, sortMap[params.sortMode]);
    if (p) { await human.mouseClick(wc, p.x, p.y); log(`  排序: ${sortMap[params.sortMode]}`); await sleep(1500, 2500); }
  }

  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (params.filterTime && timeMap[params.filterTime]) {
    const p = await findText(view, timeMap[params.filterTime]);
    if (p) { await human.mouseClick(wc, p.x, p.y); log(`  时间: ${timeMap[params.filterTime]}`); await sleep(1500, 2500); }
  }

  await human.mouseClick(wc, fp.x, fp.y);
  log('  ✓ 筛选已应用');
  await sleep(2000, 3000);
}

// ========== 工具 ==========

async function clickText(view, text) {
  const p = await findText(view, text);
  if (p) await human.mouseClick(view.webContents, p.x, p.y);
  return !!p;
}

async function findText(view, text) {
  return await js(view.webContents, `(function(){
    for(const el of document.querySelectorAll('*')){
      const t=(el.innerText||'').trim();
      if(t==='${text.replace(/'/g,"\\'")}'){
        const r=el.getBoundingClientRect();
        if(r.width>10&&r.height>10&&r.height<50&&r.y<200&&r.y>30)
          return{x:r.x+r.width/2,y:r.y+r.height/2};
      }
    }
    return null;
  })()`);
}

async function js(wc, script) {
  try { return await wc.executeJavaScript(script); } catch(_) { return null; }
}

function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }
function sleep(min, max) { const ms = max ? rand(min, max) : min; return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

module.exports = { startSearch, stopSearch, pauseSearch, isRunning };
