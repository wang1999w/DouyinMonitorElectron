/**
 * 搜索引擎模块（重构版）
 *
 * 完整流程：
 *   1. 点击搜索框 → 输入关键词 → 点击搜索
 *   2. 切换视频标签 → 鼠标悬停筛选 → 选择排序/时间 → 关闭筛选
 *   3. 扫描视频列表 → 过滤已处理ID → 滚动加载新视频
 *   4. 逐个点击视频 → 等待加载 → 打开评论 → 在评论区滚动 → 采集
 *   5. CDP + DOM 双通道采集完整数据 → 匹配 → 入库 → 推送
 *
 * 重构要点：
 *   - processVideo 提取到 videoProcessor.js 共享
 *   - scanVideos / readDomComments / clickByText 提取到 domUtils.js
 *   - processedIds 改为实例状态，每次 startSearch 时清空
 *   - 进度通过回调上报，不再依赖日志文本解析
 *   - 暂停 / 继续 / 中断 状态机更严谨
 */

const { getDouyinView, getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const dom = require('./domUtils');
const videoProcessor = require('./videoProcessor');
const scheduler = require('./scheduler');
const pipeline = require('./pipeline');
const { getLogger } = require('./logger');

const logger = getLogger('SearchEngine');

// ========== 模块状态 ==========

/** 单例运行标志：同一时刻只允许一个搜索任务 */
let searchRunning = false;
/** 暂停标志 */
let searchPaused = false;
/** 日志回调 */
let logCallback = null;
/** 进度回调 */
let progressCallback = null;
/** 当前任务实例上下文（用于清空 processedIds 等） */
let currentTask = null;
/** 上次上报的统计（避免重复推送） */
let lastStats = { matched: 0, cdp: 0, dom: 0 };

// ========== 公开 API ==========

function checkRunning() { return searchRunning; }
function checkPaused() { return searchPaused; }

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

/**
 * 启动搜索任务
 * @param {Object} params - { keywords, sortEnabled, sortMode, filterTime, filterDuration, maxVideos, commentHours, taskDuration, ... }
 * @param {Function} onLog - 日志回调
 * @param {Function} onResult - 命中结果回调
 * @param {Function} [onProgress] - 进度回调
 */
async function startSearch(params, onLog, onResult, onProgress) {
  if (searchRunning) {
    log('已有搜索任务在运行中');
    return;
  }

  searchRunning = true;
  searchPaused = false;
  logCallback = onLog;
  progressCallback = onProgress || null;
  lastStats = { matched: 0, cdp: 0, dom: 0 };

  // 任务上下文：每个任务一份，结束时释放
  const task = {
    params,
    processedIds: new Set(),
    stopped: false,
    matchedTotal: 0,
    cdpTotal: 0,
    domTotal: 0,
    videoIndex: 0,
    videoTotal: 0
  };
  currentTask = task;
  scheduler.registerSearch(params);

  const isQuantityMode = params.sortEnabled;
  log(`搜索任务启动 [${isQuantityMode ? '数量模式' : '时间模式'}] - 关键词 ${params.keywords.length} 个`);

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('浏览器未就绪'); return; }
    const wc = view.webContents;

    await ensureLogin(wc);
    if (task.stopped) return;
    if (await isCaptcha(wc)) {
      if (!(await waitForCaptchaSolved(wc))) return;
    }

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const keywords = params.keywords || [];
    const commentHours = params.commentHours || 60;
    const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 60;
    log(`  评论时效: ${commentHours}分钟内 (${new Date(cutoffTs * 1000).toLocaleString('zh-CN')})`);

    const cdp = getCDPInterceptor();
    const keywordsTotal = keywords.length;

    for (let kwIdx = 0; kwIdx < keywordsTotal; kwIdx++) {
      if (task.stopped) break;
      const kw = keywords[kwIdx];
      log(`[${kwIdx + 1}/${keywordsTotal}] 搜索关键词: ${kw}`);

      if (!(await typeKeywordAndSearch(view, kw))) { log('  搜索失败'); continue; }
      await sleepWithCheck(task, 5000, 7000);
      if (await isCaptcha(wc)) {
        if (!(await waitForCaptchaSolved(wc))) break;
        await sleepWithCheck(task, 2000);
      }

      // 切换视频标签
      await clickByTextSafe(view, '视频');
      await sleepWithCheck(task, 2000, 3000);

      // 数量模式才应用筛选
      if (isQuantityMode) {
        const hasFilter = params.sortMode && params.sortMode !== 'default'
          || params.filterTime && params.filterTime !== '0'
          || params.filterDuration && params.filterDuration !== '0';
        if (hasFilter) {
          log('  筛选...');
          await applySortFilter(view, params);
          await sleepWithCheck(task, 2000, 3000);
        }
      }

      // 处理视频
      const targetCount = isQuantityMode ? (params.maxVideos || 10) : Infinity;
      const startTime = Date.now();
      const maxDuration = isQuantityMode ? Infinity : (params.taskDuration || 30 * 60 * 1000);

      let scrollAttempts = 0;
      while (!task.stopped && task.processedIds.size < targetCount) {
        if (searchPaused) {
          if (!await waitWhilePaused(task)) break;
        }
        if (!isQuantityMode && Date.now() - startTime >= maxDuration) {
          log('  任务时间已到');
          break;
        }

        const videos = await dom.scanVideoLinks(view);
        if (videos.length === 0) {
          log('  页面无视频，滚动加载...');
          await human.mouseScroll(wc, 'down', 3);
          await sleepWithCheck(task, 3000, 5000);
          scrollAttempts++;
          if (scrollAttempts > 10) { log('  多次滚动无新视频，停止'); break; }
          continue;
        }

        // 模拟浏览
        log(`  浏览 ${videos.length} 个视频...`);
        await simulateBrowseVideos(view, videos);
        if (task.stopped) break;

        // 过滤已处理
        const unprocessed = videos.filter(v => !task.processedIds.has(v.aid));
        if (unprocessed.length === 0) {
          log(`  全部${videos.length}个视频已处理，滚动加载...`);
          await human.mouseScroll(wc, 'down', 3);
          await sleepWithCheck(task, 3000, 5000);
          scrollAttempts++;
          if (scrollAttempts > 10) { log('  多次滚动无新视频，停止'); break; }
          continue;
        }

        scrollAttempts = 0;
        log(`  发现 ${unprocessed.length} 个未处理视频`);

        // 处理第一个
        const video = unprocessed[0];
        task.processedIds.add(video.aid);
        task.videoIndex = task.processedIds.size;
        task.videoTotal = Math.max(task.videoTotal, task.videoIndex);
        log(`  [${task.videoIndex}/${targetCount === Infinity ? '∞' : targetCount}] 处理视频 ${video.aid}`);

        if (await isCaptcha(wc)) {
          if (!(await waitForCaptchaSolved(wc))) break;
        }

        const r = await videoProcessor.processVideo({
          view,
          aid: video.aid,
          keywords: { intent: intentKw, garbage: garbageKw },
          cdp,
          shouldContinue: () => !task.stopped && searchRunning,
          onProgress: (info) => reportProgress(info, task),
          onResult,
          cutoffTs
        });

        task.matchedTotal += r.matched;
        task.cdpTotal += r.cdp;
        task.domTotal += r.dom;

        // 处理间隔
        for (let w = 0; w < 3; w++) {
          if (task.stopped) break;
          await sleepWithCheck(task, 1000, 2000);
        }
      }
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

// ========== 内部辅助 ==========

function reportProgress(info, task) {
  // 日志（兼容旧逻辑）
  if (info.phase === 'click') { /* nothing extra */ }
  if (info.phase === 'error' && info.error) {
    log(`    [跳过] ${info.awemeId}: ${info.error}`);
  }
  if (info.phase === 'done') {
    log(`    [完成] CDP:${info.cdpCount} DOM:${info.domCount} 命中:${info.matchCount}`);
  }
  // 推送给渲染进程
  if (progressCallback) {
    try {
      progressCallback({
        ...info,
        videoIndex: task.videoIndex,
        videoTotal: task.videoTotal,
        matchedTotal: task.matchedTotal,
        cdpTotal: task.cdpTotal,
        domTotal: task.domTotal
      });
    } catch (_) {}
  }
}

async function waitWhilePaused(task) {
  while (searchPaused && !task.stopped) {
    await sleepWithCheck(task, 1000);
  }
  return !task.stopped;
}

/**
 * 在等待过程中检查任务是否被中断
 */
async function sleepWithCheck(task, min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  const step = 500;
  for (let t = 0; t < ms; t += step) {
    if (task.stopped) return;
    if (searchPaused) {
      await waitWhilePaused(task);
      if (task.stopped) return;
    }
    await new Promise(r => setTimeout(r, step));
  }
}

async function isCaptcha(wc) {
  try {
    return await wc.executeJavaScript(`(function(){
      const t = document.body.innerText;
      return t.includes('请完成下列验证') || t.includes('安全验证') || t.includes('拖动完成拼图') || t.includes('人机验证');
    })()`);
  } catch (e) { return false; }
}

async function waitForCaptchaSolved(wc) {
  notifyUser('检测到验证码，请在左侧页面手动完成验证');
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    if (!searchRunning) return false;
    if (!(await isCaptcha(wc))) { log('  ✅ 验证码已通过'); return true; }
  }
  return false;
}

function notifyUser(msg) {
  log(`  🔔 ${msg}`);
  try {
    const { getMainWindow } = require('../main/window');
    const win = getMainWindow();
    if (win?.webContents) win.webContents.send('search-log', `🔔 ${msg}`);
  } catch (e) {}
}

async function ensureLogin(wc) {
  const body = await wc.executeJavaScript('document.body.innerText.substring(0, 300)').catch(() => '');
  if (body.includes('登录') && body.length < 100) {
    log('请登录抖音...');
    for (let i = 0; i < 120; i++) {
      await sleep(3000);
      if (!searchRunning) return false;
      const b = await wc.executeJavaScript('document.body.innerText.substring(0, 300)').catch(() => '');
      if (!b.includes('登录') || b.length > 100) { log('登录成功'); return true; }
    }
    return false;
  }
  return true;
}

async function typeKeywordAndSearch(view, keyword) {
  const wc = view.webContents;
  const searchInput = await dom.readInputValue(view, '[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
  if (!searchInput) { log('    搜索框未找到'); return false; }

  await human.mouseClick(wc, searchInput.x, searchInput.y + 8);
  await sleep(300, 500);

  // 清空
  const len = (searchInput.val || '').length;
  if (len > 0) {
    for (let i = 0; i < len; i++) {
      await human.keyPress(wc, 'Backspace');
      await sleep(30, 60);
    }
    await sleep(200, 400);
  }

  await human.typeText(wc, keyword);
  await sleep(500, 1000);

  // 点击搜索按钮
  const btn = await wc.executeJavaScript(`(function(){
    const e = document.querySelector('[data-e2e="searchbar-button"]');
    if (e) { const r = e.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; }
    for (const b of document.querySelectorAll('button,div[role="button"]')) {
      if ((b.innerText||'').trim()==='搜索') {
        const r = b.getBoundingClientRect();
        if (r.width>10 && r.height>10 && r.y<150) return {x:r.x+r.width/2,y:r.y+r.height/2};
      }
    }
    return null;
  })()`).catch(() => null);

  if (btn) { await human.mouseClick(wc, btn.x, btn.y); log('    已搜索'); }
  else { await human.keyPress(wc, 'Enter'); }
  return true;
}

async function applySortFilter(view, params) {
  const wc = view.webContents;
  const fp = await wc.executeJavaScript(`(function(){
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText||'').trim();
      if (t.includes('筛选') && !t.includes('筛选结果')) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.width < 120 && r.y > 30 && r.y < 250)
          return { x: r.x+r.width/2, y: r.y+r.height/2 };
      }
    }
    return null;
  })()`).catch(() => null);
  if (!fp) { log('    筛选按钮未找到'); return; }

  await human.mouseHover(wc, fp.x, fp.y, 50, 20, 2000);
  await sleep(2000, 2500);

  const sortMap = { likes: '最多点赞', newest: '最新发布' };
  if (params.sortMode && sortMap[params.sortMode]) await clickFilterOption(wc, sortMap[params.sortMode]);

  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (params.filterTime && timeMap[params.filterTime]) await clickFilterOption(wc, timeMap[params.filterTime]);

  const durMap = { short: '1分钟以下', mid: '1-5分钟', long: '5分钟以上' };
  if (params.filterDuration && durMap[params.filterDuration]) await clickFilterOption(wc, durMap[params.filterDuration]);

  await sleep(1000, 2000);
  await human.mouseClick(wc, fp.x, fp.y);
  log('    筛选已应用');
  await sleep(2000, 3000);
}

async function clickFilterOption(wc, text) {
  try {
    const pos = await wc.executeJavaScript(`(function(){
      for (const el of document.querySelectorAll('button,span,div,label,a')) {
        const t = (el.innerText||'').trim();
        if (t !== '${text.replace(/'/g, "\\'")}') continue;
        const r = el.getBoundingClientRect();
        if (r.width>5 && r.height>5 && r.height<60 && r.width<200 && r.y>100)
          return { x:r.x+r.width/2, y:r.y+r.height/2 };
      }
      return null;
    })()`).catch(() => null);
    if (pos) { await human.mouseClick(wc, pos.x, pos.y); await sleep(800, 1500); }
  } catch (e) {}
}

async function clickByTextSafe(view, text) {
  return dom.clickByText(view, text);
}

async function simulateBrowseVideos(view, videos) {
  const wc = view.webContents;
  const browseCount = Math.min(rand(2, 4), videos.length);
  const indices = [];
  while (indices.length < browseCount) {
    const idx = rand(0, videos.length - 1);
    if (!indices.includes(idx)) indices.push(idx);
  }

  for (const idx of indices) {
    const aid = videos[idx].aid;
    const cardPos = await wc.executeJavaScript(`(function(){
      const links = document.querySelectorAll('a[href*="/video/${aid}"]');
      for (const a of links) {
        const card = a.closest('[class*="card"]') || a;
        const r = card.getBoundingClientRect();
        if (r.width > 50 && r.height > 50)
          return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height };
      }
      return null;
    })()`).catch(() => null);

    if (!cardPos) continue;

    await human.mouseMove(wc, cardPos.x, cardPos.y);
    await sleep(rand(1500, 3000));
    await human.mouseMove(wc, cardPos.x + rand(-30, 30), cardPos.y + rand(-20, 20));
    await sleep(rand(500, 1500));
  }

  await sleep(rand(1000, 3000));
}

// ========== 工具 ==========

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

module.exports = { startSearch, stopSearch, pauseSearch, isRunning, checkRunning, checkPaused };
