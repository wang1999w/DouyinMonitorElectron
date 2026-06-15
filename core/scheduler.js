/**
 * 全局任务调度器
 * 核心闭环：监控任务优先级 > 搜索任务
 * 时间触发：每个博主配置独立的触发时间点（如 "09:00"、"14:00"）
 * 到点自动执行一次监控任务，完成后自动休息或恢复搜索
 */

const { getLogger } = require('./logger');
const logger = getLogger('Scheduler');

const TASK_STATE = { IDLE: 'idle', SEARCHING: 'searching', MONITORING: 'monitoring', SEARCH_PAUSED: 'search_paused' };

let state = TASK_STATE.IDLE;
let searchParams = null;
let searchAbortFlag = false;
let monitorTimer = null;
let logCallback = null;
let lastTriggerMinute = -1; // 防止同一分钟内重复触发

function init(onLog) {
  logCallback = onLog;
  monitorTimer = setInterval(tick, 30000);
  log('调度器已启动');
}

/**
 * 调度器心跳（每 30 秒检查）
 * 检查是否有博主的触发时间点到了
 */
async function tick() {
  if (state === TASK_STATE.MONITORING) return;

  try {
    const config = require('./config');
    const cfg = config.loadConfig();
    const bloggers = (cfg.monitor_bloggers || []).filter(b => b.status === 1);
    if (bloggers.length === 0) return;

    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // 同一分钟内只触发一次
    if (currentMinute === lastTriggerMinute) return;

    for (const blogger of bloggers) {
      const triggerTimes = blogger.trigger_times || [];
      if (triggerTimes.length === 0) continue;

      for (const tt of triggerTimes) {
        if (tt === currentTime) {
          lastTriggerMinute = currentMinute;
          log(`触发监控任务: ${blogger.nickname} (时间点 ${tt})`);
          const config = require('./config');
          const cfg = config.loadConfig();
          await executeMonitorWithPriority(blogger, cfg);
          return;
        }
      }
    }
  } catch (e) {
    log(`调度异常: ${e.message}`);
  }
}

/**
 * 带优先级的监控执行
 * 搜索运行中 → 暂停搜索 → 执行监控 → 回首页 → 恢复搜索
 */
async function executeMonitorWithPriority(blogger, cfg) {
  const searchEngine = require('./search');

  // 如果搜索正在运行，暂停它
  if (state === TASK_STATE.SEARCHING) {
    log('监控任务优先：暂停搜索任务');
    searchAbortFlag = true;
    state = TASK_STATE.SEARCH_PAUSED;
    // 等待搜索实际停止（最多 10 秒）
    for (let i = 0; i < 20; i++) {
      if (!searchEngine.isRunning()) break;
      await sleep(500);
    }
  }

  // 执行监控
  state = TASK_STATE.MONITORING;
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
  if (searchAbortFlag && searchParams) {
    state = TASK_STATE.IDLE;
    searchAbortFlag = false;
    log('监控完成，恢复搜索任务');
    state = TASK_STATE.SEARCHING;
    const searchEngine = require('./search');
    await searchEngine.startSearch(searchParams, logCallback);
  } else {
    state = TASK_STATE.IDLE;
    searchAbortFlag = false;
  }

  log('监控任务完成');
}

async function navigateHome(view) {
  try {
    const { keyPress, typeText } = require('./humanBehavior');
    const wc = view.webContents;
    await keyPress(wc, 'l', ['ctrl']);
    await sleep(200, 400);
    await keyPress(wc, 'a', ['ctrl']);
    await sleep(50, 100);
    await keyPress(wc, 'Backspace');
    await sleep(100, 200);
    await typeText(wc, 'https://www.douyin.com');
    await sleep(200, 400);
    await keyPress(wc, 'Enter');
    await sleep(2000, 3000);
  } catch (e) {}
}

function registerSearch(params) {
  searchParams = params;
  state = TASK_STATE.SEARCHING;
  searchAbortFlag = false;
}

function notifySearchDone() {
  if (state !== TASK_STATE.SEARCH_PAUSED) {
    state = TASK_STATE.IDLE;
  }
  searchParams = null;
}

function shouldAbortSearch() { return searchAbortFlag; }
function getState() { return state; }

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
