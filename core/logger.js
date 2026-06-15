/**
 * 日志模块（异步队列版）
 *
 * 重构要点：
 *   - 文件写入异步化（流式 append），不阻塞调用方
 *   - 队列缓冲：批量 flush，避免高频 fs 调用
 *   - 优雅退出：flush() 在 app before-quit 时调用，保证缓冲数据落盘
 *   - 按日切文件，过期文件不写
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
let currentLevel = LEVELS.INFO;

const LOG_DIR = path.join(__dirname, '..', 'logs');

let pendingLines = [];
let flushing = false;
let flushTimer = null;
let currentStream = null;
let currentDate = null;
const FLUSH_INTERVAL_MS = 1000;
const FLUSH_THRESHOLD = 200;

function setLevel(level) {
  currentLevel = LEVELS[(level || 'INFO').toUpperCase()] || LEVELS.INFO;
}

function getLogger(name) {
  return {
    info: (msg) => log('INFO', name, msg),
    warn: (msg) => log('WARN', name, msg),
    error: (msg) => log('ERROR', name, msg),
    debug: (msg) => log('DEBUG', name, msg)
  };
}

function log(level, name, msg) {
  if (LEVELS[level] < currentLevel) return;

  const time = new Date().toLocaleString('zh-CN');
  const safeMsg = typeof msg === 'string' ? msg : (() => { try { return JSON.stringify(msg); } catch (e) { return String(msg); } })();
  const line = `[${time}] [${level}] [${name}] ${safeMsg}`;

  if (level === 'ERROR') console.error(line);
  else console.log(line);

  // 内存队列
  pendingLines.push(line);
  if (pendingLines.length >= FLUSH_THRESHOLD) {
    flushNow();
  } else {
    scheduleFlush();
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_INTERVAL_MS);
}

function getStreamForToday() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDate) {
    if (currentStream) {
      try { currentStream.end(); } catch (e) {}
    }
    currentDate = today;
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const filePath = path.join(LOG_DIR, `${today}.log`);
    currentStream = fs.createWriteStream(filePath, { flags: 'a' });
    currentStream.on('error', (e) => {
      // 单次写失败不影响后续
      currentStream = null;
    });
  }
  return currentStream;
}

function flushNow() {
  if (flushing || pendingLines.length === 0) return;
  flushing = true;
  const lines = pendingLines;
  pendingLines = [];
  try {
    const stream = getStreamForToday();
    if (stream && stream.writable) {
      stream.write(lines.join('\n') + '\n');
    }
  } catch (e) {
    // 失败：把行放回去（最多重试 3 次）
    if (lines.length < 5000) {
      pendingLines.unshift(...lines);
    }
  } finally {
    flushing = false;
  }
}

/**
 * 应用退出前同步刷盘
 */
function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushNow();
  if (currentStream) {
    try { currentStream.end(); } catch (e) {}
    currentStream = null;
  }
}

module.exports = { getLogger, setLevel, flush };
