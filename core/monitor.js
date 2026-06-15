/**
 * 博主监控引擎（重构版）
 *
 * 采集流程：
 *   1. 跳转到博主主页
 *   2. 滚动加载视频列表
 *   3. 逐个处理视频：调用共享 videoProcessor 完成点击→评论→采集→匹配
 *   4. 博主独立关键词匹配 → 评分 → 入库 → 推送
 *
 * 调度器触发时：先确保浏览器空闲 → 执行监控 → 通知 scheduler 完成
 */

const { getDouyinView, getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const dom = require('./domUtils');
const videoProcessor = require('./videoProcessor');
const pipeline = require('./pipeline');
const scheduler = require('./scheduler');
const { getLogger } = require('./logger');

const logger = getLogger('MonitorEngine');

// ========== 模块状态 ==========

let monitorRunning = false;
let logCallback = null;
let progressCallback = null;
// 当前监控任务上下文（每个博主一次，结束时释放）
let currentTask = null;

function checkRunning() { return monitorRunning; }

function startMonitor(onLog, onProgress) {
  if (monitorRunning) return false;
  monitorRunning = true;
  logCallback = onLog;
  progressCallback = onProgress || null;
  log('监控已启动（手动模式）');
  return true;
}

function stopMonitor() {
  if (currentTask) currentTask.stopped = true;
  monitorRunning = false;
  log('监控已停止');
}

/**
 * 执行单个博主的监控（由调度器调用，或手动触发）
 * @param {Object} blogger { sec_uid, nickname, intent_keywords, garbage_keywords, comment_hours }
 * @param {Object} cfg - 全局配置（暂未使用，保留兼容）
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
  const secUid = blogger.sec_uid || '';
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

  const view = getDouyinView();
  if (!view || !view.webContents) { log('浏览器未就绪'); currentTask = null; return stats; }
  const wc = view.webContents;
  const cdp = getCDPInterceptor();

  // 博主独立关键词
  const intentKw = blogger.intent_keywords || [];
  const garbageKw = blogger.garbage_keywords || [];
  const commentHours = blogger.comment_hours || 60;
  const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 60;
  log(`  评论时效: ${commentHours}分钟内`);

  try {
    // 1. 跳转到博主主页
    await navigateByUrl(view, `https://www.douyin.com/user/${secUid}`);
    await sleep(3000, 5000);
    if (task.stopped) return stats;

    // 2. 滚动加载视频列表
    for (let i = 0; i < 5; i++) {
      if (task.stopped) break;
      await human.mouseScroll(wc, 'down', 1);
      await sleep(1000, 2000);
    }
    if (task.stopped) return stats;

    // 3. 扫描视频列表
    const videos = await dom.scanBloggerVideos(view);
    log(`  发现 ${videos.length} 个视频`);
    task.videoTotal = videos.length;
    if (videos.length === 0) return stats;

    // 4. 逐个处理
    for (const video of videos) {
      if (task.stopped) break;
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
        shouldContinue: () => !task.stopped && monitorRunning,
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

      // 视频间间隔
      for (let w = 0; w < 3; w++) {
        if (task.stopped) break;
        await sleep(1000, 2000);
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

/** 通过地址栏导航（键盘模拟） */
async function navigateByUrl(view, url) {
  await view.webContents.loadURL(url);
}

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startMonitor, stopMonitor, executeSingleBlogger, checkRunning };
