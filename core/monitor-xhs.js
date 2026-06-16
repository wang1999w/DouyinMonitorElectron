/**
 * 小红书博主监控引擎
 *
 * 流程：跳转博主主页 → 滚动加载笔记列表 → 逐个处理笔记
 * 博主使用 user_id（十六进制）替代 sec_uid
 */

const dom = require('./domUtils-xhs');
const noteProcessor = require('./noteProcessor');
const human = require('./humanBehavior');
const { getLogger } = require('./logger');

const logger = getLogger('XHS-Monitor');

let monitorRunning = false;
let logCallback = null;
let resultCallback = null;
let currentTask = null;

function isRunning() { return monitorRunning; }

function startMonitor(onLog, onResult, onProgress, getViewFn, getCdpFn) {
  if (monitorRunning) return false;
  monitorRunning = true;
  logCallback = onLog;
  resultCallback = onResult;
  log('小红书监控已启动');

  executeAllBloggers(getViewFn, getCdpFn, onProgress).catch(e => {
    log(`监控异常: ${e.message}`);
    logger.error(`小红书监控异常: ${e.stack || e.message}`);
  });
  return true;
}

function stopMonitor() {
  if (currentTask) currentTask.stopped = true;
  monitorRunning = false;
  log('小红书监控已停止');
}

async function executeAllBloggers(getViewFn, getCdpFn, onProgress) {
  try {
    const cfg = require('./config').loadConfig();
    const bloggers = (cfg.xhs_monitor_bloggers || []).filter(b => b.status === 1);
    if (bloggers.length === 0) {
      log('无启用的小红书监控博主');
      monitorRunning = false;
      return;
    }
    log(`开始监控 ${bloggers.length} 个小红书博主`);

    for (const blogger of bloggers) {
      if (!monitorRunning) break;
      await executeSingleBlogger(blogger, cfg, getViewFn, getCdpFn, onProgress);
    }
    log('所有博主监控完成');
  } catch (e) {
    log(`监控异常: ${e.message}`);
  } finally {
    monitorRunning = false;
  }
}

async function executeSingleBlogger(blogger, cfg, getViewFn, getCdpFn, onProgress) {
  const nickname = blogger.nickname || '未知博主';
  const userId = blogger.user_id || '';
  log(`监控博主: ${nickname}`);

  const task = { stopped: false, videoIndex: 0, videoTotal: 0, matchedTotal: 0, cdpTotal: 0, domTotal: 0 };
  currentTask = task;

  const view = getViewFn();
  if (!view || !view.webContents) { log('浏览器未就绪'); currentTask = null; return; }
  const wc = view.webContents;
  const cdp = getCdpFn();

  const intentKw = blogger.intent_keywords || [];
  const garbageKw = blogger.garbage_keywords || [];
  const commentMins = blogger.comment_hours || 60;
  const cutoffTs = Math.floor(Date.now() / 1000) - commentMins * 60;

  try {
    // 1. 跳转到博主主页
    await wc.loadURL(`https://www.xiaohongshu.com/user/profile/${userId}`);
    await dom.sleep(3000, 5000);
    // 模拟人类进入博主主页后的浏览行为
    await human.humanPause(wc, human.rand(2000, 4000));
    if (task.stopped) return;

    // 2. 滚动加载笔记列表
    for (let i = 0; i < 5; i++) {
      if (task.stopped) break;
      await human.mouseScroll(wc, 'down', 1);
      await dom.sleep(1000, 2000);
    }
    if (task.stopped) return;

    // 3. 扫描笔记列表
    const notes = await dom.scanNoteLinks(view);
    log(`  发现 ${notes.length} 个笔记`);
    task.videoTotal = notes.length;
    if (notes.length === 0) return;

    // 4. 逐个处理
    for (const note of notes) {
      if (task.stopped) break;
      task.videoIndex++;
      log(`  [${task.videoIndex}/${task.videoTotal}] 处理笔记 ${note.noteId}`);

      const noteInfo = {
        note_id: note.noteId,
        title: '',
        author: nickname,
        note_url: `https://www.xiaohongshu.com/explore/${note.noteId}`
      };

      const r = await noteProcessor.processNote({
        view, noteId: note.noteId, videoInfo: noteInfo,
        keywords: { intent: intentKw, garbage: garbageKw },
        cdp,
        shouldContinue: () => !task.stopped && monitorRunning,
        onProgress: (info) => {
          if (onProgress) {
            try {
              onProgress({ ...info, videoIndex: task.videoIndex, videoTotal: task.videoTotal, matchedTotal: task.matchedTotal });
            } catch (_) {}
          }
        },
        onResult: (result) => {
          task.matchedTotal++;
          if (logCallback) logCallback(`    [命中] ${result.nickname}: ${(result.text || '').slice(0, 30)}`);
          if (resultCallback) resultCallback(result);
        },
        cutoffTs
      });

      task.cdpTotal += r.cdp;
      task.domTotal += r.dom;
      // matchedTotal 已在 onResult 中递增

      // 笔记间间隔
      for (let w = 0; w < 3; w++) {
        if (task.stopped) break;
        await dom.sleep(1000, 2000);
      }
    }

    log(`博主 ${nickname} 监控完成: ${task.videoIndex}笔记 ${task.matchedTotal}命中`);
  } catch (e) {
    log(`监控博主异常: ${e.message}`);
  } finally {
    currentTask = null;
  }
}

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

module.exports = { startMonitor, stopMonitor, isRunning };
