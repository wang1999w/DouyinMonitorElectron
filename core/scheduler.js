/**
 * 全局任务调度器（重构版）
 *
 * 核心闭环：监控任务优先级 > 搜索任务 > 空闲
 * 时间触发：
 *   - 博主监控：每个博主配置独立的触发时间点（如 "09:00"、"14:00"）
 *   - 搜索定时：根据 search_schedule 配置（时间段 + 间隔分钟数）
 *
 * 重构要点：
 *   - 同一分钟多博主同时触发：串行执行而非只触发第一个
 *   - 状态机加超时保护：监控卡死时强制回到 IDLE
 *   - search_schedule 真正落地：根据时间段 + 间隔触发搜索
 *   - 调度日志通过全局回调推送，渲染进程实时显示
 */

const { getLogger } = require('./logger');
const logger = getLogger('Scheduler');

const TASK_STATE = {
  IDLE: 'idle',
  SEARCHING: 'searching',
  MONITORING: 'monitoring',
  SEARCH_PAUSED: 'search_paused'
};

const TICK_MS = 30000; // 30 秒心跳

let state = TASK_STATE.IDLE;
let searchParams = null;
let searchAbortFlag = false;
let monitorTimer = null;
let logCallback = null;
let lastTriggerMinute = -1;          // 防止同一分钟重复触发博主监控
let lastSearchTriggerTs = 0;          // 上次搜索触发时间戳
let searchIntervalMs = 0;             // 搜索间隔（毫秒）

function init(onLog) {
  logCallback = onLog;
  if (monitorTimer) return;
  monitorTimer = setInterval(tick, TICK_MS);
  log('调度器已启动');
}

function destroy() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  state = TASK_STATE.IDLE;
}

/**
 * 调度心跳（每 30 秒）
 * 1. 检查博主监控触发时间
 * 2. 检查搜索定时（search_schedule）
 */
async function tick() {
  if (state === TASK_STATE.MONITORING) return;

  try {
    const config = require('./config');
    const cfg = config.loadConfig();

    // 博主监控触发
    await checkBloggerTriggers(cfg);

    // 搜索定时触发
    checkSearchSchedule(cfg);
  } catch (e) {
    log(`调度异常: ${e.message}`);
    state = TASK_STATE.IDLE;
    searchAbortFlag = false;
  }
}

async function checkBloggerTriggers(cfg) {
  const bloggers = (cfg.monitor_bloggers || []).filter(b => b.status === 1);
  if (bloggers.length === 0) return;

  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // 同一分钟只检测一次博主触发
  if (currentMinute === lastTriggerMinute) return;
  lastTriggerMinute = currentMinute;

  // 找出当前分钟到点的所有博主
  const pendingBloggers = [];
  for (const blogger of bloggers) {
    const triggerTimes = blogger.trigger_times || [];
    if (triggerTimes.length === 0) continue;
    if (triggerTimes.includes(currentTime)) {
      pendingBloggers.push(blogger);
    }
  }

  if (pendingBloggers.length === 0) return;

  if (pendingBloggers.length > 1) {
    log(`本分钟有 ${pendingBloggers.length} 个博主到点，串行执行`);
  }

  for (const blogger of pendingBloggers) {
    log(`触发监控任务: ${blogger.nickname} (时间点 ${currentTime})`);
    await executeMonitorWithPriority(blogger, cfg);
    if (state === TASK_STATE.MONITORING) break; // 状态机异常保护
  }
}

function checkSearchSchedule(cfg) {
  const schedule = cfg.search_schedule;
  if (!schedule || !schedule.enabled) return;

  const now = new Date();
  const hh = now.getHours();
  const mm = now.getMinutes();
  const startHour = Number(schedule.startHour ?? 8);
  const endHour = Number(schedule.endHour ?? 22);
  if (hh < startHour || hh >= endHour) return;

  const intervalMin = Number(schedule.intervalMinutes ?? 30);
  if (!Number.isFinite(intervalMin) || intervalMin < 1) return;

  searchIntervalMs = intervalMin * 60 * 1000;
  const sinceLast = Date.now() - lastSearchTriggerTs;
  if (lastSearchTriggerTs > 0 && sinceLast < searchIntervalMs) return;

  // 检查关键词与博主列表
  if (state === TASK_STATE.IDLE && (cfg.search_keywords || []).length > 0) {
    const params = {
      keywords: cfg.search_keywords,
      sortEnabled: !!cfg.search_sort_enabled,
      sortMode: cfg.search_sort_mode || 'default',
      filterTime: String(cfg.search_filter_time || '0'),
      filterDuration: cfg.search_filter_duration || '0',
      maxVideos: cfg.search_max_videos || 30,
      commentHours: cfg.search_comment_hours || 60,
      taskDuration: cfg.search_task_duration || 30 * 60 * 1000,
      triggeredBySchedule: true
    };
    lastSearchTriggerTs = Date.now();
    log(`定时搜索触发 (${intervalMin}分钟间隔)`);
    const searchEngine = require('./search');
    searchEngine.startSearch(params, logCallback).catch(e => log(`定时搜索异常: ${e.message}`));
  }
}

/**
 * 带优先级的监控执行
 * 搜索运行中 → 暂停搜索 → 执行监控 → 回首页 → 恢复搜索
 */
async function executeMonitorWithPriority(blogger, cfg) {
  const searchEngine = require('./search');
  const monitorEngine = require('./monitor');

  const wasSearching = state === TASK_STATE.SEARCHING;
  if (wasSearching) {
    log('监控任务优先：暂停搜索任务');
    searchAbortFlag = true;
    state = TASK_STATE.SEARCH_PAUSED;
    for (let i = 0; i < 20; i++) {
      if (!searchEngine.isRunning()) break;
      await sleep(500);
    }
    if (searchEngine.isRunning()) {
      log('搜索任务未能在10秒内停止，强制终止');
      searchEngine.stopSearch();
    }
  }

  state = TASK_STATE.MONITORING;
  const monitorStart = Date.now();
  // 监控超时保护（30 分钟硬上限）
  const MONITOR_TIMEOUT_MS = 30 * 60 * 1000;
  try {
    const monitorPromise = monitorEngine.executeSingleBlogger(blogger, cfg, logCallback);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('监控超时')), MONITOR_TIMEOUT_MS)
    );
    await Promise.race([monitorPromise, timeoutPromise]);
  } catch (e) {
    log(`监控执行异常: ${e.message}`);
  } finally {
    logger.info(`博主监控耗时 ${Math.round((Date.now() - monitorStart) / 1000)}s`);
    // 监控完成后回到首页
    try {
      const { getDouyinView } = require('../main/window');
      const view = getDouyinView();
      if (view && view.webContents) await navigateHome(view);
    } catch (e) { log(`恢复首页失败: ${e.message}`); }
  }

  // 恢复搜索
  try {
    if (wasSearching && searchAbortFlag && searchParams && !searchParams.triggeredBySchedule) {
      log('监控完成，恢复搜索任务');
      state = TASK_STATE.SEARCHING;
      searchAbortFlag = false;
      await searchEngine.startSearch(searchParams, logCallback);
    } else {
      state = TASK_STATE.IDLE;
      searchAbortFlag = false;
    }
  } catch (e) {
    log(`恢复搜索异常: ${e.message}`);
    state = TASK_STATE.IDLE;
    searchAbortFlag = false;
  }

  log('监控任务完成');
}

async function navigateHome(view) {
  try {
    await view.webContents.loadURL('https://www.douyin.com');
    await sleep(2000, 3000);
  } catch (e) {}
}

function registerSearch(params) {
  searchParams = params;
  if (state !== TASK_STATE.SEARCH_PAUSED && state !== TASK_STATE.MONITORING) {
    state = TASK_STATE.SEARCHING;
  }
  searchAbortFlag = false;
}

function notifySearchDone() {
  // 如果是被监控抢占的，不清理 searchParams（恢复时需要）
  if (state === TASK_STATE.SEARCH_PAUSED || state === TASK_STATE.MONITORING) {
    // 保留 searchParams 以便恢复
  } else {
    state = TASK_STATE.IDLE;
    searchParams = null;
  }
}

function notifyMonitorDone(secUid) {
  // monitor 引擎在 finally 中调用，确保状态机不会卡在 MONITORING
  if (state === TASK_STATE.MONITORING) {
    state = TASK_STATE.IDLE;
  }
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

module.exports = {
  init, destroy,
  registerSearch, notifySearchDone, notifyMonitorDone,
  shouldAbortSearch, getState,
  executeMonitorWithPriority,
  TASK_STATE
};
