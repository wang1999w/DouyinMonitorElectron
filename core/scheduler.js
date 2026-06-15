/**
 * 全局任务调度器
 * 核心闭环：监控任务优先级 > 搜索任务
 * 机制：监控触发时暂停搜索 → 执行监控 → 回到首页 → 恢复搜索
 */

const { getLogger } = require('./logger');
const logger = getLogger('Scheduler');

/** 任务状态 */
const TASK_STATE = {
  IDLE: 'idle',
  SEARCHING: 'searching',
  MONITORING: 'monitoring',
  SEARCH_PAUSED: 'search_paused'
};

let state = TASK_STATE.IDLE;
let searchParams = null;
let searchAbortFlag = false;
let monitorTimer = null;
let logCallback = null;

/**
 * 初始化调度器
 * @param {Function} onLog - 日志回调
 */
function init(onLog) {
  logCallback = onLog;
  monitorTimer = setInterval(tick, 30000);
  log('调度器已启动');
}

/**
 * 调度器心跳（每 30 秒检查一次）
 * 检查是否有博主的监控时间到了
 */
async function tick() {
  if (state === TASK_STATE.MONITORING) return;

  try {
    const config = require('./config');
    const cfg = config.loadConfig();
    const bloggers = (cfg.monitor_bloggers || []).filter(b => b.status === 1);

    if (bloggers.length === 0) return;

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    for (const blogger of bloggers) {
      if (!blogger.time_ranges || blogger.time_ranges.length === 0) continue;

      for (const tr of blogger.time_ranges) {
        try {
          const parts = tr.split('-');
          if (parts.length !== 2) continue;
          const [sh, sm] = parts[0].split(':').map(Number);
          const [eh, em] = parts[1].split(':').map(Number);
          const startMin = sh * 60 + sm;
          const endMin = eh * 60 + em;

          // 在时间段的前 2 分钟内触发（避免重复触发）
          if (nowMinutes >= startMin && nowMinutes <= startMin + 2) {
            log(`触发监控任务: ${blogger.nickname} (${tr})`);
            await executeMonitorWithPriority(blogger, cfg);
            return; // 一次只执行一个博主的监控
          }
        } catch (e) { continue; }
      }
    }
  } catch (e) {
    log(`调度异常: ${e.message}`);
  }
}

/**
 * 带优先级的监控执行
 * 如果搜索正在运行 → 暂停搜索 → 执行监控 → 恢复搜索
 */
async function executeMonitorWithPriority(blogger, cfg) {
  const monitorEngine = require('./monitor');
  const searchEngine = require('./search');
  const database = require('./database');

  // 如果搜索正在运行，暂停它
  if (state === TASK_STATE.SEARCHING) {
    log('监控任务优先：暂停搜索任务');
    searchAbortFlag = true;
    state = TASK_STATE.SEARCH_PAUSED;
    // 等待搜索实际停止
    for (let i = 0; i < 30; i++) {
      if (state === TASK_STATE.SEARCH_PAUSED) break;
      await sleep(500);
    }
  }

  // 执行监控
  state = TASK_STATE.MONITORING;
  log(`开始执行监控: ${blogger.nickname}`);

  try {
    const monitorEngine = require('./monitor');
    await monitorEngine.executeSingleBlogger(blogger, cfg, logCallback);

    // 监控完成后回到首页
    const { getDouyinView } = require('../main/window');
    const view = getDouyinView();
    if (view && view.webContents) {
      await navigateHome(view);
    }
  } catch (e) {
    log(`监控执行异常: ${e.message}`);
  }

  // 恢复搜索
  if (state === TASK_STATE.MONITORING && searchAbortFlag) {
    state = TASK_STATE.IDLE;
    searchAbortFlag = false;
    if (searchParams) {
      log('监控完成，恢复搜索任务');
      const searchEngine = require('./search');
      state = TASK_STATE.SEARCHING;
      await searchEngine.resumeSearch(searchParams, logCallback);
    } else {
      state = TASK_STATE.IDLE;
    }
  } else {
    state = TASK_STATE.IDLE;
  }

  log('监控任务完成');
}

/**
 * 导航回首页
 */
async function navigateHome(view) {
  try {
    await sendKey(view, 'l', ['ctrl']);
    await sleep(200, 400);
    await sendKey(view, 'a', ['ctrl']);
    await sleep(50, 100);
    await sendKey(view, 'Backspace');
    await sleep(100, 200);
    const url = 'https://www.douyin.com';
    for (const ch of url) {
      await sendChar(view, ch);
      await sleep(10, 25);
    }
    await sleep(200, 400);
    await sendKey(view, 'Enter');
    await sleep(2000, 3000);
  } catch (e) {}
}

async function sendKey(view, key, modifiers) {
  const mods = modifiers || [];
  await view.webContents.sendInputEvent({ type: 'keyDown', key, keyCode: key, modifiers: mods });
  await sleep(30, 60);
  await view.webContents.sendInputEvent({ type: 'keyUp', key, keyCode: key, modifiers: mods });
  await sleep(30, 60);
}

async function sendChar(view, char) {
  await view.webContents.sendInputEvent({ type: 'char', char });
  await sleep(8, 20);
}

/**
 * 注册搜索任务（供搜索模块调用）
 */
function registerSearch(params) {
  searchParams = params;
  state = TASK_STATE.SEARCHING;
  searchAbortFlag = false;
}

/**
 * 通知搜索任务完成
 */
function notifySearchDone() {
  if (state !== TASK_STATE.SEARCH_PAUSED) {
    state = TASK_STATE.IDLE;
  }
  searchParams = null;
}

/**
 * 检查是否应该中止搜索
 */
function shouldAbortSearch() {
  return searchAbortFlag;
}

/**
 * 获取当前状态
 */
function getState() {
  return state;
}

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

function destroy() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  state = TASK_STATE.IDLE;
}

module.exports = {
  init, destroy,
  registerSearch, notifySearchDone, shouldAbortSearch,
  getState, executeMonitorWithPriority,
  TASK_STATE
};
