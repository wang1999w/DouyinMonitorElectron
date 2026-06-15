/**
 * 搜索引擎（严格遵循老版本流程编排）
 *
 * 老版本流程（Python Playwright）：
 *   1. 导航到抖音首页 → 检查登录
 *   2. 输入关键词 → 点击搜索按钮 → 等待5-7秒
 *   3. 检查异常（验证码）→ 切换视频标签 → 应用筛选
 *   4. 循环：扫描视频列表 → 过滤已处理 → 悬停预览 → 点击打开 → 模拟观看8-20秒
 *   5. 按x打开评论区 → 检查是否打开 → 滚动加载评论
 *   6. API拦截 + DOM采集 → 关键词匹配 → 入库
 *   7. ESC退出 → 随机暂停15-60秒 → 模拟浏览列表 → 下一个视频
 *
 * Electron 适配：
 *   - loadURL 替代 page.goto（更稳定）
 *   - executeJavaScript 替代 page.evaluate
 *   - sendInputEvent 替代 page.keyboard.press
 *   - humanBehavior 模拟鼠标/键盘
 *   - CDP 拦截替代 Playwright response 事件
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
let progressCallback = null;
let currentTask = null;

function checkRunning() { return searchRunning; }

function stopSearch() {
  if (currentTask) currentTask.stopped = true;
  searchPaused = false;
  log('搜索已停止');
}

function pauseSearch() {
  if (searchRunning) {
    searchPaused = !searchPaused;
    log(searchPaused ? '搜索已暂停' : '搜索已继续');
  }
}

function isRunning() { return searchRunning; }

// ========== 主流程（严格遵循老版本编排） ==========

async function startSearch(params, onLog, onResult, onProgress) {
  if (searchRunning) { log('已有搜索任务在运行中'); return; }
  searchRunning = true;
  searchPaused = false;
  logCallback = onLog;
  progressCallback = onProgress || null;

  const task = {
    params, processedIds: new Set(), stopped: false,
    matchedTotal: 0, cdpTotal: 0, domTotal: 0,
    videoIndex: 0, videoTotal: 0
  };
  currentTask = task;
  scheduler.registerSearch(params);

  const isQuantityMode = params.sortEnabled;
  log(`搜索任务启动 [${isQuantityMode ? '数量模式' : '时间模式'}] - 关键词 ${params.keywords.length} 个`);

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('浏览器未就绪'); return; }
    const wc = view.webContents;

    // === 步骤1：检查登录 ===
    await checkLogin(view, task);
    if (task.stopped) return;

    // === 步骤2：检查验证码 ===
    await checkCaptchaLoop(view, task);

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const keywords = params.keywords || [];
    const commentHours = params.commentHours || 60;
    const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 60;
    const cdp = getCDPInterceptor();

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (task.stopped) break;
      const kw = keywords[kwIdx];

      log(`[${kwIdx + 1}/${keywords.length}] 搜索关键词: ${kw}`);

      // === 步骤3：导航到搜索页（loadURL，稳定可靠） ===
      const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`;
      log(`  导航到搜索页...`);
      await wc.loadURL(searchUrl);
      await dom.sleep(5000, 7000);

      // 验证：只读 URL，不重新加载
      const url = await execJS(wc, 'location.href') || '';
      log(`  当前URL: ${url.substring(0, 60)}`);
      if (!url.includes('search')) {
        log('  ❌ 未到搜索页，跳过');
        continue;
      }

      // 检查验证码
      await checkCaptchaLoop(view, task);

      // === 步骤4：切换视频标签 ===
      log('  切换到视频标签...');
      const tabPos = await findTextPosition(view, '视频');
      if (tabPos) {
        await human.mouseClick(wc, tabPos.x, tabPos.y);
        await dom.sleep(2000, 3000);
        log('  ✓ 已切换到视频标签');
      } else {
        log('  ⚠ 未找到视频标签');
      }

      // === 步骤5：应用筛选（数量模式） ===
      if (isQuantityMode) {
        const hasFilter = params.sortMode !== 'default' || params.filterTime !== '0' || params.filterDuration !== '0';
        if (hasFilter) {
          log('  应用筛选...');
          await applyFilter(view, params);
          await dom.sleep(2000, 3000);
        }
      }

      // === 步骤6：视频处理循环（老版本逻辑） ===
      const targetCount = isQuantityMode ? (params.maxVideos || 10) : Infinity;
      const startTime = Date.now();
      const maxDuration = isQuantityMode ? Infinity : (params.taskDuration || 30 * 60 * 1000);
      let collectedCount = 0;
      let consecutiveFailures = 0;
      let scrollAttempts = 0;
      let videosSincePause = 0;
      let pauseAfter = rand(1, 3);

      while (!task.stopped && collectedCount < targetCount) {
        if (searchPaused) { await waitWhilePaused(task); if (task.stopped) break; }
        if (!isQuantityMode && Date.now() - startTime >= maxDuration) { log('任务时间已到'); break; }

        // 扫描视频列表
        log(`扫描视频列表... (已采集${collectedCount}/${targetCount})`);
        let videos = await dom.scanVideoLinks(view);

        // 过滤已处理
        let unprocessed = videos.filter(v => !task.processedIds.has(v.aid));

        if (unprocessed.length === 0) {
          log('无更多未处理视频，向下滚动...');
          await human.mouseScroll(wc, 'down', 3);
          await dom.sleep(2000, 3000);
          scrollAttempts++;
          if (scrollAttempts > 10) { log('多次滚动无新视频，停止'); break; }
          continue;
        }

        scrollAttempts = 0;

        // 随机打乱顺序（老版本逻辑）
        unprocessed.sort(() => Math.random() - 0.5);
        const v = unprocessed[0];
        const aid = v.aid;
        collectedCount++;

        log(`\n====== [${collectedCount}/${targetCount}] 视频 ${aid} ======`);

        // 检查验证码
        await checkCaptchaLoop(view, task);

        // 处理视频
        const result = await videoProcessor.processVideo({
          view, aid,
          keywords: { intent: intentKw, garbage: garbageKw },
          cdp,
          shouldContinue: () => !task.stopped && searchRunning,
          onProgress: (info) => reportProgress(info, task),
          onResult,
          cutoffTs
        });

        if (result.skipped) {
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            log('连续3次失败，检查异常...');
            await checkCaptchaLoop(view, task);
            consecutiveFailures = 0;
          }
          continue;
        }

        consecutiveFailures = 0;
        task.processedIds.add(aid);
        task.matchedTotal += result.matched;
        task.cdpTotal += result.cdp;
        task.domTotal += result.dom;

        // 老版本：随机暂停模拟浏览
        videosSincePause++;
        if (videosSincePause >= pauseAfter) {
          const pauseSec = rand(15, 60);
          log(`\n⏸️ 随机暂停 ${pauseSec}秒，模拟浏览...`);
          await human.mouseMove(wc, rand(400, 800), rand(300, 500));
          await dom.sleep(pauseSec * 1000);
          videosSincePause = 0;
          pauseAfter = rand(1, 3);
          if (task.stopped) break;
        }

        // 老版本：模拟浏览列表
        await simulateBrowse(view);

        log(`====== [${collectedCount}/${targetCount}] 完成 ======`);
      }

      log(`关键词 [${kw}] 完成！`);
    }

    log(`搜索完成！共 ${task.matchedTotal} 条意向`);
  } catch (e) {
    log(`搜索异常: ${e.message}`);
    logger.error(`startSearch 异常: ${e.stack || e.message}`);
  } finally {
    searchRunning = false;
    searchPaused = false;
    currentTask = null;
    scheduler.notifySearchDone();
  }
}

// ========== 辅助函数 ==========

async function checkLogin(view, task) {
  const wc = view.webContents;
  const body = await execJS(wc, 'document.body.innerText.substring(0, 300)') || '';
  if (body.includes('登录') && body.length < 100) {
    log('请登录抖音...');
    for (let i = 0; i < 120; i++) {
      await sleep(3000);
      if (task.stopped) return;
      const b = await execJS(wc, 'document.body.innerText.substring(0, 300)') || '';
      if (!b.includes('登录') || b.length > 100) { log('登录成功'); return; }
    }
  }
}

async function checkCaptchaLoop(view, task) {
  if (!(await dom.hasCaptcha(view))) return;
  log('⚠ 验证码检测到，等待手动处理...');
  notifyUser('验证码检测到，请在左侧页面手动完成');
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    if (task.stopped) return;
    if (!(await dom.hasCaptcha(view))) { log('✅ 验证码已通过'); return; }
  }
}

async function applyFilter(view, params) {
  const wc = view.webContents;
  const fp = await findTextPosition(view, '筛选');
  if (!fp) { log('  筛选按钮未找到'); return; }

  // 悬停打开筛选面板（老版本：mouse.move 悬停，不是点击）
  await human.mouseHover(wc, fp.x, fp.y, 50, 20, 2000);
  await dom.sleep(2000, 2500);

  // 选择排序
  const sortMap = { likes: '最多点赞', newest: '最新发布' };
  if (params.sortMode && sortMap[params.sortMode]) {
    const pos = await findTextPosition(view, sortMap[params.sortMode]);
    if (pos) { await human.mouseClick(wc, pos.x, pos.y); log(`  排序: ${sortMap[params.sortMode]}`); await dom.sleep(1500, 2500); }
  }

  // 选择时间
  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (params.filterTime && timeMap[params.filterTime]) {
    const pos = await findTextPosition(view, timeMap[params.filterTime]);
    if (pos) { await human.mouseClick(wc, pos.x, pos.y); log(`  时间: ${timeMap[params.filterTime]}`); await dom.sleep(1500, 2500); }
  }

  // 点击筛选按钮关闭面板（老版本：click filter_loc 关闭）
  await human.mouseClick(wc, fp.x, fp.y);
  log('  筛选已应用');
  await dom.sleep(2000, 3000);
}

/**
 * 模拟浏览列表（老版本逻辑）
 * 随机悬停2-4个视频卡片，模拟真人浏览
 */
async function simulateBrowse(view) {
  const wc = view.webContents;
  const count = rand(2, 4);
  log(`模拟浏览 ${count} 个视频...`);

  for (let i = 0; i < count; i++) {
    if (!checkRunning()) break;
    // 随机找一个视频卡片
    const pos = await execJS(wc, `(function(){
      const cards = document.querySelectorAll('[class*="card"], [class*="video-card"], a[href*="/video/"]');
      const valid = [];
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        if (r.width > 80 && r.height > 80 && r.y > 50) {
          valid.push({ x: r.x+r.width/2, y: r.y+r.height/2, w: r.width, h: r.height });
        }
      }
      if (valid.length === 0) return null;
      return valid[Math.floor(Math.random() * valid.length)];
    })()`);

    if (pos) {
      await human.mouseHover(wc, pos.x, pos.y, pos.w, pos.h, rand(1000, 3000));
    }
    await dom.sleep(500, 1500);
  }

  await dom.sleep(1000, 3000);
}

async function findTextPosition(view, text) {
  return await execJS(view.webContents, `(function(){
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText||'').trim();
      if (t === '${text.replace(/'/g, "\\'")}') {
        const r = el.getBoundingClientRect();
        if (r.width>10 && r.height>10 && r.height<50 && r.y<200 && r.y>30)
          return { x:r.x+r.width/2, y:r.y+r.height/2 };
      }
    }
    return null;
  })()`);
}

async function execJS(wc, script) {
  try { return await wc.executeJavaScript(script); } catch (_) { return null; }
}

function reportProgress(info, task) {
  if (info.phase === 'error' && info.error) log(`  [跳过] ${info.awemeId}: ${info.error}`);
  if (info.phase === 'done') log(`  [完成] CDP:${info.cdpCount} DOM:${info.domCount} 命中:${info.matchCount}`);
  if (progressCallback) {
    try { progressCallback({ ...info, videoIndex: task.videoIndex, videoTotal: task.videoTotal, matchedTotal: task.matchedTotal }); } catch (_) {}
  }
}

async function waitWhilePaused(task) {
  while (searchPaused && !task.stopped) { await sleep(500); }
}

function notifyUser(msg) {
  log(`🔔 ${msg}`);
  try {
    const { getMainWindow } = require('../main/window');
    const win = getMainWindow();
    if (win?.webContents) win.webContents.send('search-log', `🔔 ${msg}`);
  } catch (e) {}
}

function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min) + min); }

module.exports = { startSearch, stopSearch, pauseSearch, isRunning };
