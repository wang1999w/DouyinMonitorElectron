/**
 * 博主监控引擎（重构版）
 *
 * 采集流程：
 *   1. 跳转到博主主页（支持短链/完整URL/sec_uid 三种格式）
 *   2. 滚动加载视频列表
 *   3. 逐个处理视频：调用共享 videoProcessor 完成点击评论采集匹配
 *   4. 博主独立关键词匹配  评分  入库  推送
 *
 * 规范化规则：
 *   - sec_uid 字段允许填入：短链(https://v.douyin.com/xxx)、完整主页URL、纯 sec_uid
 *   - 博主独立关键词为空时，自动回退到全局 monitor_intent_keywords / monitor_garbage_keywords
 *   - date_value 用于过滤作品日期（天），0 表示不过滤
 *   - comment_hours 评论时效（小时），过滤超过时效的评论
 *   - 支持暂停/恢复/停止，与 search/recommend 模块行为一致
 *
 * 调度器触发时：先确保浏览器空闲  执行监控  通知 scheduler 完成
 */

const { createMonitorWindow, getMonitorView, getMonitorCDPInterceptor, closeMonitorWindow } = require('../main/window');
const human = require('./humanBehavior');
const dom = require('./domUtils');
const videoProcessor = require('./videoProcessor');
const pipeline = require('./pipeline');
const scheduler = require('./scheduler');
const { getLogger } = require('./logger');
const { getStateMachine, STATES } = require('./stateMachine');
const { getErrorAnalyzer, CATEGORIES, SEVERITY } = require('./errorAnalyzer');
const { getRecoveryManager } = require('./recovery');

const logger = getLogger('MonitorEngine');

// ========== 模块状态 ==========

let monitorRunning = false;
let monitorPaused = false;
let _completeCallback = null;
let logCallback = null;
let progressCallback = null;
// 当前监控任务上下文（每个博主一次，结束时释放）
let currentTask = null;
// 缓存：sec_uid 字段原值 -> 解析后的真实 sec_uid（避免每次都跟随重定向）
const secUidCache = new Map();
// 记录被暂停的其他任务（监控结束后恢复）
let pausedOtherTasks = { search: false, recommend: false };
// 定时触发循环（检查 trigger_times）
let triggerLoopTimer = null;
let lastTriggerMinute = -1;

function checkRunning() { return monitorRunning; }
function isRunning() { return monitorRunning; }
function isPaused() { return monitorPaused; }

// ========== 启动 / 停止 / 暂停 ==========

function startMonitor(onLog, onProgress, onComplete) {
  if (monitorRunning) return false;
  monitorRunning = true;
  monitorPaused = false;
  logCallback = onLog;
  progressCallback = onProgress || null;
  _completeCallback = onComplete;
  // 重置 videoProcessor 模块级中断标志
  if (videoProcessor.setInterruptFlag) videoProcessor.setInterruptFlag(false);
  log('监控已启动（待命模式）');

  // ★ 打开独立监控窗口（与其他任务窗口隔离），停在首页等待定时触发
  try {
    createMonitorWindow();
    log('已打开监控专用窗口，停在首页等待预设时间触发');
  } catch (e) {
    logger.warn(`创建监控窗口失败: ${e.message}`);
  }

  // ★ 注意：不在此处暂停其他任务，只在 trigger_times 到点触发时才暂停
  // 待命模式下其他任务可以正常运行

  getStateMachine().transition(STATES.MONITORING, { phase: 'waiting', taskDesc: '博主监控(待命)' });

  // ★ 启动定时触发循环：检查 trigger_times，到点才执行对应博主
  // 不再立即执行 executeAllBloggers
  startTriggerLoop();

  return true;
}

/**
 * 暂停其他正在执行的任务（搜索/推荐）
 * 记录被暂停的任务，监控结束后恢复
 */
function pauseOtherTasks() {
  pausedOtherTasks = { search: false, recommend: false };
  try {
    const searchEngine = require('./search');
    if (searchEngine.isRunning && searchEngine.isRunning() && !(searchEngine.isPaused && searchEngine.isPaused())) {
      if (searchEngine.pauseSearch) {
        searchEngine.pauseSearch();
        pausedOtherTasks.search = true;
        log('已暂停搜索任务（监控优先）');
      }
    }
  } catch (e) { logger.warn(`暂停搜索任务异常: ${e.message}`); }
  try {
    const recommendEngine = require('./recommend');
    if (recommendEngine.isRunning && recommendEngine.isRunning() && !(recommendEngine.isPaused && recommendEngine.isPaused())) {
      if (recommendEngine.pauseRecommend) {
        recommendEngine.pauseRecommend();
        pausedOtherTasks.recommend = true;
        log('已暂停推荐任务（监控优先）');
      }
    }
  } catch (e) { logger.warn(`暂停推荐任务异常: ${e.message}`); }
}

/**
 * 恢复之前被暂停的其他任务
 */
function resumeOtherTasks() {
  try {
    if (pausedOtherTasks.search) {
      const searchEngine = require('./search');
      if (searchEngine.isPaused && searchEngine.isPaused() && searchEngine.pauseSearch) {
        searchEngine.pauseSearch(); // 再次调用切换为恢复
        log('已恢复搜索任务');
      }
    }
  } catch (e) { logger.warn(`恢复搜索任务异常: ${e.message}`); }
  try {
    if (pausedOtherTasks.recommend) {
      const recommendEngine = require('./recommend');
      if (recommendEngine.isPaused && recommendEngine.isPaused() && recommendEngine.pauseRecommend) {
        recommendEngine.pauseRecommend(); // 再次调用切换为恢复
        log('已恢复推荐任务');
      }
    }
  } catch (e) { logger.warn(`恢复推荐任务异常: ${e.message}`); }
  pausedOtherTasks = { search: false, recommend: false };
}

/**
 * 停止监控（异步，确保状态完全清理）
 */
async function stopMonitor() {
  if (!monitorRunning && !monitorPaused) {
    log('No running monitor task');
    return { stopped: false, reason: 'not_running' };
  }
  log('正在停止监控任务...');
  monitorRunning = false;
  monitorPaused = false;
  // ★ 停止定时触发循环
  stopTriggerLoop();
  // 立即触发 videoProcessor 模块级中断标志
  if (videoProcessor.setInterruptFlag) videoProcessor.setInterruptFlag(true);
  if (currentTask) currentTask.stopped = true;

  const state = getStateMachine();
  if (state.current === STATES.MONITORING || state.current === STATES.PAUSED) {
    state.transition(STATES.IDLE, { phase: 'stopped', taskDesc: null });
  }

  // 等待当前视频处理退出（最多 1.5 秒）
  for (let i = 0; i < 15; i++) {
    await sleep(100);
  }
  // ★ 恢复被暂停的其他任务
  resumeOtherTasks();
  // ★ 关闭监控专用窗口
  try { closeMonitorWindow(); } catch (e) { logger.warn(`关闭监控窗口异常: ${e.message}`); }
  log('🛑 监控任务已停止');
  if (_completeCallback) {
    try { _completeCallback({ success: true, reason: 'user_stopped' }); }
    catch (e) { console.warn('stopMonitor onComplete error:', e.message); }
    _completeCallback = null;
  }
  return { stopped: true, reason: 'user_stopped' };
}

/**
 * 暂停/恢复监控（切换状态）
 * 暂停通过 shouldContinue 回调返回 false 实现，不设置中断标志
 */
async function pauseMonitor() {
  if (!monitorRunning) {
    log('No running monitor task to pause');
    return { paused: false, reason: 'not_running' };
  }
  monitorPaused = !monitorPaused;
  // ★ 暂停时不设置 _globalInterrupted（那会导致 processVideo 完全退出）
  // 暂停通过 shouldContinue 回调返回 false 来实现，wait/sleep 内部会等待恢复
  // 只有停止时才设置 _globalInterrupted = true
  if (videoProcessor.setInterruptFlag) {
    videoProcessor.setInterruptFlag(false);
  }
  const state = getStateMachine();
  if (monitorPaused) {
    state.transition(STATES.PAUSED, { phase: 'user_paused' });
    log('⏸ 监控已暂停（点击恢复继续）');
  } else {
    state.transition(STATES.MONITORING, { phase: 'resumed' });
    log('▶ 监控已恢复');
  }
  return { paused: monitorPaused };
}

/**
 * 启动定时触发循环
 * 每 30 秒检查一次 trigger_times，到点执行对应博主
 * 同一分钟只触发一次，避免重复执行
 */
function startTriggerLoop() {
  if (triggerLoopTimer) return;
  log('定时触发检查已启动（每30秒检查一次预设时间）');
  // 立即检查一次（不等待 30 秒）
  checkTriggers();
  triggerLoopTimer = setInterval(checkTriggers, 30000);
}

/**
 * 停止定时触发循环
 */
function stopTriggerLoop() {
  if (triggerLoopTimer) {
    clearInterval(triggerLoopTimer);
    triggerLoopTimer = null;
    log('定时触发检查已停止');
  }
}

/**
 * 检查 trigger_times，到点执行对应博主
 */
async function checkTriggers() {
  if (!monitorRunning || monitorPaused) return;
  if (currentTask) return; // 正在执行任务，跳过

  const cfg = require('./config').loadConfig();
  const bloggers = (cfg.monitor_bloggers || []).filter(b => b.status === 1);
  if (bloggers.length === 0) return;

  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  // 同一分钟只触发一次
  if (currentMinute === lastTriggerMinute) return;
  lastTriggerMinute = currentMinute;

  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // 找出到点的博主
  const pending = bloggers.filter(b => {
    const times = b.trigger_times || [];
    return times.includes(currentTime);
  });

  if (pending.length === 0) return;

  log(`⏰ 到达预设时间 ${currentTime}，触发 ${pending.length} 个博主监控`);

  // ★ 触发监控任务时暂停其他正在执行的任务（搜索/推荐）
  pauseOtherTasks();

  // 串行执行到点的博主
  for (const blogger of pending) {
    if (!monitorRunning) break;
    // 暂停等待
    if (monitorPaused) {
      log('监控已暂停，等待恢复后再执行触发任务');
      while (monitorPaused && monitorRunning) { await sleep(300); }
      if (!monitorRunning) break;
    }
    getStateMachine().setPhase('monitoring_blogger', { currentBlogger: blogger.nickname });
    try {
      await executeSingleBlogger(blogger, cfg, logCallback, progressCallback);
    } catch (e) {
      log(`执行博主 ${blogger.nickname} 异常: ${e.message}`);
      logger.error(`checkTriggers executeSingleBlogger 异常: ${e.stack || e.message}`);
    }
  }

  // ★ 恢复被暂停的其他任务
  resumeOtherTasks();

  // 执行完毕，导航回首页等待下一次触发
  if (monitorRunning) {
    const view = getMonitorView();
    if (view && view.webContents && !view.webContents.isDestroyed()) {
      try {
        log('本轮监控完成，回到首页等待下一次触发');
        await view.webContents.loadURL('https://www.douyin.com');
      } catch (e) {
        logger.warn(`导航回首页异常: ${e.message}`);
      }
    }
  }
}

/**
 * 执行单个博主的监控（由调度器调用，或手动触发）
 * @param {Object} blogger { sec_uid, nickname, intent_keywords, garbage_keywords, comment_hours, date_value }
 * @param {Object} cfg - 全局配置（用于关键词回退）
 * @param {Function} [onLog] - 日志回调
 * @param {Function} [onProgress] - 进度回调
 * @returns {Promise<{videos:number, matched:number, cdp:number, dom:number}>}
 */
async function executeSingleBlogger(blogger, cfg, onLog, onProgress) {
  const savedCb = logCallback;
  const savedProg = progressCallback;
  if (onLog) logCallback = onLog;
  if (onProgress) progressCallback = onProgress;

  if (!monitorRunning) monitorRunning = true;

  const nickname = blogger.nickname || '未知博主';
  log(`监控博主: ${nickname}`);

  const task = {
    blogger,
    stopped: false,
    videoIndex: 0,
    videoTotal: 0,
    matchedTotal: 0,
    cdpTotal: 0,
    domTotal: 0
  };
  currentTask = task;

  const stats = { videos: 0, matched: 0, cdp: 0, dom: 0 };

  // ★ 使用监控专用窗口（与其他任务窗口隔离）
  const view = getMonitorView();
  if (!view || !view.webContents) { log('监控窗口未就绪'); currentTask = null; return stats; }
  const wc = view.webContents;
  const cdp = getMonitorCDPInterceptor();

  // ★ 关键词回退规则：博主独立关键词为空时，使用全局 monitor_intent_keywords / monitor_garbage_keywords
  let intentKw = Array.isArray(blogger.intent_keywords) ? blogger.intent_keywords : [];
  let garbageKw = Array.isArray(blogger.garbage_keywords) ? blogger.garbage_keywords : [];
  if (intentKw.length === 0 && cfg) {
    intentKw = Array.isArray(cfg.monitor_intent_keywords) ? cfg.monitor_intent_keywords : [];
    if (intentKw.length > 0) log(`  博主未配置意向关键词，回退到全局 (${intentKw.length}个)`);
  }
  if (garbageKw.length === 0 && cfg) {
    garbageKw = Array.isArray(cfg.monitor_garbage_keywords) ? cfg.monitor_garbage_keywords : [];
    if (garbageKw.length > 0) log(`  博主未配置垃圾关键词，回退到全局 (${garbageKw.length}个)`);
  }

  // 评论时效（小时）
  const commentHours = Math.max(1, parseInt(blogger.comment_hours) || 60);
  const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 3600;
  log(`  评论时效: ${commentHours}小时内`);

  // 作品日期筛选（天）：0=不过滤
  const dateValue = Math.max(0, parseInt(blogger.date_value) || 0);
  if (dateValue > 0) {
    log(`  作品日期筛选: ${dateValue}天内`);
  }

  try {
    // 1. 解析 sec_uid 字段并跳转到博主主页
    const realSecUid = await resolveSecUid(blogger.sec_uid, view);
    if (!realSecUid) {
      log(`  跳过: 无法解析博主主页地址 (${blogger.sec_uid})`);
      return stats;
    }
    if (task.stopped) return stats;

    // ★ 等待监控窗口 BrowserView 完成初始加载（CDP 拦截器就绪）
    await waitForMonitorViewReady(view);
    if (task.stopped) return stats;

    const homeUrl = `https://www.douyin.com/user/${realSecUid}`;
    log(`  跳转主页: ${homeUrl}`);
    await navigateByUrl(view, homeUrl);
    await wait(3000, 5000);
    if (task.stopped) return stats;

    // 2. 滚动加载视频列表
    for (let i = 0; i < 5; i++) {
      if (task.stopped) break;
      if (monitorPaused) { await waitWhilePaused(task); if (task.stopped) break; }
      await human.mouseScroll(wc, 'down', 1);
      await wait(1000, 2000);
    }
    if (task.stopped) return stats;

    // 3. 扫描视频列表
    const allVideos = await dom.scanVideoLinks(view);
    log(`  发现 ${allVideos.length} 个视频`);

    // ★ 作品日期筛选：date_value 天内的作品才处理
    let videos = allVideos;
    if (dateValue > 0 && allVideos.length > 0) {
      videos = await filterVideosByDate(view, allVideos, dateValue);
      log(`  日期筛选(${dateValue}天内): ${allVideos.length} → ${videos.length} 个视频`);
    }

    task.videoTotal = videos.length;
    if (videos.length === 0) return stats;

    // 4. 逐个处理
    for (const video of videos) {
      if (task.stopped) break;
      if (monitorPaused) { await waitWhilePaused(task); if (task.stopped) break; }

      task.videoIndex++;
      stats.videos++;
      log(`  [${task.videoIndex}/${task.videoTotal}] 处理视频 ${video.aid}`);

      const videoInfo = {
        aweme_id: video.aid,
        desc: '',
        author: nickname,
        video_url: `https://www.douyin.com/video/${video.aid}`,
        blogger: nickname
      };

      const r = await videoProcessor.processVideo({
        view,
        aid: video.aid,
        videoInfo,
        keywords: { intent: intentKw, garbage: garbageKw },
        cdp,
        shouldContinue: () => !task.stopped && monitorRunning && !monitorPaused,
        onProgress: (info) => reportProgress(info, task),
        onResult: (result) => {
          if (logCallback) logCallback(`    [命中] ${result.nickname}: ${result.text.slice(0, 30)} -> ${result.matched_keywords.join(',')}`);
        },
        cutoffTs
      });

      stats.matched += r.matched;
      stats.cdp += r.cdp;
      stats.dom += r.dom;
      task.matchedTotal += r.matched;
      task.cdpTotal += r.cdp;
      task.domTotal += r.dom;

      // 视频间间隔（可中断 + 可暂停）
      for (let w = 0; w < 3; w++) {
        if (task.stopped) break;
        if (monitorPaused) { await waitWhilePaused(task); if (task.stopped) break; }
        await wait(1000, 2000);
      }
    }

    log(`博主 ${nickname} 监控完成: ${stats.videos}视频 ${stats.matched}命中`);
  } catch (e) {
    log(`监控博主异常: ${e.message}`);
    logger.error(`executeSingleBlogger 异常: ${e.stack || e.message}`);
  } finally {
    currentTask = null;
    logCallback = savedCb;
    progressCallback = savedProg;
    scheduler.notifyMonitorDone(blogger.sec_uid);
  }

  return stats;
}

/**
 * 解析 sec_uid 字段
 * 支持三种输入格式：
 *   1. 纯 sec_uid: "MS4wLjABAAAA..."  -> 直接返回
 *   2. 完整主页URL: "https://www.douyin.com/user/MS4wLjABAAAA..."  -> 提取
 *   3. 短链分享URL: "https://v.douyin.com/rJizjEkFYh4/"  -> 跟随重定向获取真实URL
 *   4. 带杂质的字符串（用户粘贴分享文本）: "https://v.douyin.com/rJizjEkFYh4/ 7@8.com :2pm"  -> 提取URL部分
 * @param {string} raw - 原始 sec_uid 字段值
 * @param {Object} view - BrowserView 实例（用于跟随短链重定向）
 * @returns {Promise<string|null>} 真实 sec_uid，失败返回 null
 */
async function resolveSecUid(raw, view) {
  if (!raw || typeof raw !== 'string') return null;
  const input = raw.trim();

  // 命中缓存
  if (secUidCache.has(input)) return secUidCache.get(input);

  // 规则1: 纯 sec_uid（通常以 MS4 开头，长度 70+，无斜杠/冒号）
  if (!input.includes('/') && !input.includes(':') && input.length > 30) {
    secUidCache.set(input, input);
    return input;
  }

  // 规则2: 完整主页URL - 直接提取
  // 形如 https://www.douyin.com/user/MS4wLjABAAAA...?xxx
  // 或 https://www.iesdouyin.com/share/user/MS4wLjABAAAA...?xxx
  const fullUrlMatch = input.match(/(?:douyin|iesdouyin)\.com\/(?:share\/)?user\/([A-Za-z0-9_-]+)/);
  if (fullUrlMatch) {
    const secUid = fullUrlMatch[1];
    secUidCache.set(input, secUid);
    return secUid;
  }

  // 规则3: 短链 URL - 从杂质文本中提取 URL
  // 用户粘贴分享文本形如 "https://v.douyin.com/rJizjEkFYh4/ 7@8.com :2pm"
  const shortUrlMatch = input.match(/https?:\/\/[^\s]+\/[A-Za-z0-9]+\/?/);
  if (!shortUrlMatch) {
    logger.warn(`resolveSecUid: 无法识别的博主地址格式: ${input}`);
    return null;
  }
  const shortUrl = shortUrlMatch[0];

  // 跟随短链重定向获取真实主页URL
  try {
    if (!view || !view.webContents) {
      logger.warn('resolveSecUid: view 不可用，无法跟随短链');
      return null;
    }
    log(`  解析短链: ${shortUrl}`);
    // 使用 net 模块跟随重定向（不污染当前页面）
    const realUrl = await followRedirect(shortUrl);
    if (!realUrl) {
      logger.warn(`resolveSecUid: 短链重定向失败: ${shortUrl}`);
      return null;
    }
    // 匹配多种重定向URL格式：
    //   - douyin.com/user/SEC_UID
    //   - iesdouyin.com/share/user/SEC_UID
    //   - 查询参数 sec_uid=SEC_UID
    let secUid = null;
    const pathMatch = realUrl.match(/(?:douyin|iesdouyin)\.com\/(?:share\/)?user\/([A-Za-z0-9_-]+)/);
    if (pathMatch) {
      secUid = pathMatch[1];
    } else {
      const queryMatch = realUrl.match(/[?&]sec_uid=([A-Za-z0-9_-]+)/);
      if (queryMatch) secUid = queryMatch[1];
    }
    if (!secUid) {
      logger.warn(`resolveSecUid: 重定向URL未包含 sec_uid: ${realUrl}`);
      return null;
    }
    secUidCache.set(input, secUid);
    log(`  解析成功: ${secUid}`);
    return secUid;
  } catch (e) {
    logger.warn(`resolveSecUid 异常: ${e.message}`);
    return null;
  }
}

/**
 * 跟随 URL 重定向，返回最终 URL（不下载 body）
 * 使用 Node.js 内置 https 模块（Electron net 模块的 manual redirect 会触发 error 事件）
 */
function followRedirect(url, maxRedirects = 5) {
  return new Promise((resolve) => {
    try {
      const https = require('https');
      const http = require('http');
      const lib = url.startsWith('https') ? https : http;
      const req = lib.request(url, { method: 'GET', timeout: 8000 }, (res) => {
        const status = res.statusCode;
        const location = res.headers.location || res.headers.Location;
        res.destroy(); // 不下载 body
        if (status >= 300 && status < 400 && location && maxRedirects > 0) {
          const nextUrl = location.startsWith('http') ? location : new URL(location, url).href;
          setTimeout(() => followRedirect(nextUrl, maxRedirects - 1).then(resolve), 100);
        } else {
          // 不再重定向，当前URL即为最终URL
          resolve(url);
        }
      });
      req.on('error', (e) => {
        logger.warn(`followRedirect error: ${e.message}`);
        resolve(null);
      });
      req.on('timeout', () => {
        try { req.destroy(); } catch (_) {}
        resolve(null);
      });
      req.end();
    } catch (e) {
      logger.warn(`followRedirect exception: ${e.message}`);
      resolve(null);
    }
  });
}

/**
 * 根据 date_value 过滤视频列表
 * 从博主主页 DOM 获取视频卡片的发布日期文本，解析后过滤超期作品
 * @param {Object} view - BrowserView
 * @param {Array} videos - scanVideoLinks 返回的视频列表
 * @param {number} dateValue - 日期筛选（天）
 * @returns {Promise<Array>} 过滤后的视频列表
 */
async function filterVideosByDate(view, videos, dateValue) {
  if (!view || !view.webContents || dateValue <= 0) return videos;
  const cutoffMs = Date.now() - dateValue * 86400000;

  // 从 DOM 获取视频卡片的日期信息
  const dateMap = await getVideoDatesFromDOM(view);
  if (dateMap.size === 0) {
    logger.warn('filterVideosByDate: 未能从 DOM 获取视频日期，跳过过滤');
    return videos;
  }

  const filtered = [];
  let skipped = 0;
  for (const video of videos) {
    const aid = String(video.aid).replace(/^card_/, '');
    const videoMs = dateMap.get(aid);
    if (videoMs && videoMs < cutoffMs) {
      skipped++;
      continue; // 超过日期，跳过
    }
    filtered.push(video);
  }
  if (skipped > 0) log(`  日期过滤: 跳过 ${skipped} 个超期作品`);
  return filtered;
}

/**
 * 从博主主页 DOM 获取视频卡片的发布日期
 * 抖音博主主页视频卡片通常显示"X天前"、"X周前"、"MM-DD"等日期文本
 * @param {Object} view - BrowserView
 * @returns {Promise<Map<string, number>>} aid -> 发布时间戳(ms)
 */
async function getVideoDatesFromDOM(view) {
  const script = `
    (function() {
      const results = {};
      // 策略1: 查找所有 /video/{aid} 链接，向上遍历父容器查找日期文本
      const links = document.querySelectorAll('a[href*="/video/"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/\\/video\\/(\\d+)/);
        if (!m) continue;
        const aid = m[1];
        if (results[aid]) continue;
        // 向上查找 5 层父容器，寻找日期文本
        let container = link;
        for (let i = 0; i < 6; i++) {
          container = container.parentElement;
          if (!container) break;
          const text = container.textContent || '';
          // 匹配: X天前 / X周前 / X月前 / X年前 / MM-DD / YYYY-MM-DD / X月X日
          const dateMatch = text.match(/(\\d+)\\s*天前|(\\d+)\\s*周前|(\\d+)\\s*个月前|(\\d+)\\s*月前|(\\d+)\\s*年前|(\\d{4})-(\\d{1,2})-(\\d{1,2})|(\\d{1,2})-(\\d{1,2})|(\\d{1,2})月(\\d{1,2})日/);
          if (dateMatch) {
            results[aid] = dateMatch[0];
            break;
          }
        }
      }
      // 策略2: 查找带 data-e2e-vid / data-vid 的卡片
      const cards = document.querySelectorAll('[data-e2e-vid], [data-vid]');
      for (const card of cards) {
        const aid = card.getAttribute('data-e2e-vid') || card.getAttribute('data-vid');
        if (!aid || results[aid]) continue;
        const text = card.textContent || '';
        const dateMatch = text.match(/(\\d+)\\s*天前|(\\d+)\\s*周前|(\\d+)\\s*个月前|(\\d+)\\s*月前|(\\d+)\\s*年前|(\\d{4})-(\\d{1,2})-(\\d{1,2})|(\\d{1,2})-(\\d{1,2})|(\\d{1,2})月(\\d{1,2})日/);
        if (dateMatch) {
          results[aid] = dateMatch[0];
        }
      }
      return JSON.stringify(results);
    })();
  `;
  try {
    const result = await view.webContents.executeJavaScript(script);
    const obj = JSON.parse(result || '{}');
    const dateMap = new Map();
    for (const [aid, dateText] of Object.entries(obj)) {
      const ms = parseVideoDate(dateText);
      if (ms) dateMap.set(aid, ms);
    }
    return dateMap;
  } catch (e) {
    logger.warn(`getVideoDatesFromDOM 异常: ${e.message}`);
    return new Map();
  }
}

/**
 * 解析视频日期文本为时间戳(ms)
 * 支持: X天前 / X周前 / X月前 / X年前 / MM-DD / YYYY-MM-DD / X月X日
 * @param {string} text - 日期文本
 * @returns {number|null} 时间戳(ms)，解析失败返回 null
 */
function parseVideoDate(text) {
  if (!text || typeof text !== 'string') return null;
  const now = Date.now();
  let m;
  if ((m = text.match(/(\d+)\s*天前/))) return now - parseInt(m[1]) * 86400000;
  if ((m = text.match(/(\d+)\s*周前/))) return now - parseInt(m[1]) * 7 * 86400000;
  if ((m = text.match(/(\d+)\s*个月前/))) return now - parseInt(m[1]) * 30 * 86400000;
  if ((m = text.match(/(\d+)\s*月前/))) return now - parseInt(m[1]) * 30 * 86400000;
  if ((m = text.match(/(\d+)\s*年前/))) return now - parseInt(m[1]) * 365 * 86400000;
  if ((m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])).getTime();
  if ((m = text.match(/(\d{1,2})-(\d{1,2})/))) return new Date(new Date().getFullYear(), parseInt(m[1]) - 1, parseInt(m[2])).getTime();
  if ((m = text.match(/(\d{1,2})月(\d{1,2})日/))) return new Date(new Date().getFullYear(), parseInt(m[1]) - 1, parseInt(m[2])).getTime();
  return null;
}

/**
 * 等待暂停恢复（不退出任务）
 */
async function waitWhilePaused(task) {
  if (!monitorPaused) return;
  log('  ⏸ 监控已暂停，等待恢复...');
  while (monitorPaused && monitorRunning && !task.stopped) {
    await sleep(300);
  }
}

function reportProgress(info, task) {
  if (info.phase === 'error' && info.error) {
    log(`    [跳过] ${info.awemeId}: ${info.error}`);
  }
  if (info.phase === 'done') {
    log(`    [完成] CDP:${info.cdpCount} DOM:${info.domCount} 命中:${info.matchCount}`);
  }
  if (progressCallback) {
    try {
      progressCallback({
        ...info,
        videoIndex: task.videoIndex,
        videoTotal: task.videoTotal,
        matchedTotal: task.matchedTotal,
        cdpTotal: task.cdpTotal,
        domTotal: task.domTotal,
        bloggerNickname: task.blogger.nickname,
        bloggerSecUid: task.blogger.sec_uid
      });
    } catch (_) {}
  }
}

/**
 * 等待监控窗口 BrowserView 完成初始加载并就绪
 * 检查项：
 *   1. view 与 webContents 存在且未销毁
 *   2. webContents 完成首次加载（isLoading() === false）
 *   3. CDP 拦截器已挂载（getMonitorCDPInterceptor() 返回非空）
 * 超时（15s）后记录警告但不阻塞流程
 * @param {Object} view - BrowserView 实例
 * @returns {Promise<boolean>} true=就绪, false=超时或异常
 */
async function waitForMonitorViewReady(view) {
  if (!view || !view.webContents) {
    log('  监控窗口未就绪: view 不存在');
    return false;
  }
  const wc = view.webContents;
  if (wc.isDestroyed && wc.isDestroyed()) {
    log('  监控窗口未就绪: webContents 已销毁');
    return false;
  }

  const TIMEOUT_MS = 15000;
  const STEP_MS = 300;
  const maxSteps = Math.ceil(TIMEOUT_MS / STEP_MS);
  let loadingReady = false;
  let cdpReady = false;

  for (let i = 0; i < maxSteps; i++) {
    if (!monitorRunning) return false;
    // 检查 webContents 是否已销毁
    if (wc.isDestroyed && wc.isDestroyed()) {
      log('  监控窗口未就绪: webContents 已销毁');
      return false;
    }
    // 检查加载状态
    if (!loadingReady && !wc.isLoading()) {
      loadingReady = true;
      log('  监控窗口页面加载完成');
    }
    // 检查 CDP 拦截器
    if (!cdpReady) {
      const cdp = getMonitorCDPInterceptor();
      if (cdp) {
        cdpReady = true;
        log('  监控窗口 CDP 拦截器已就绪');
      }
    }
    // 两者都就绪 → 返回
    if (loadingReady && cdpReady) {
      return true;
    }
    await sleep(STEP_MS);
  }

  // 超时
  if (!loadingReady) log('  ⚠ 监控窗口页面加载超时（15s），继续执行');
  if (!cdpReady) log('  ⚠ 监控窗口 CDP 拦截器未就绪（15s），继续执行');
  return false;
}

/** 通过地址栏导航 */
async function navigateByUrl(view, url) {
  await view.webContents.loadURL(url);
}

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

/**
 * 可中断 + 可暂停的 sleep
 */
async function wait(min, max) {
  const total = max ? Math.floor(Math.random() * (max - min) + min) : min;
  const step = 300;
  for (let t = 0; t < total; t += step) {
    if (!monitorRunning) return false;
    if (monitorPaused) {
      // 暂停期间持续等待，不消耗剩余时长
      while (monitorPaused && monitorRunning) { await sleep(300); }
      if (!monitorRunning) return false;
    }
    await sleep(Math.min(step, total - t));
  }
  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  startMonitor,
  stopMonitor,
  pauseMonitor,
  executeSingleBlogger,
  checkRunning,
  isRunning,
  isPaused,
  // 暴露给测试用
  _resolveSecUid: resolveSecUid,
  _clearCache: () => secUidCache.clear()
};
