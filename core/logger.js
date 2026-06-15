/**
 * 日志模块
 * 提供统一的日志接口，支持控制台输出和文件记录
 */

const fs = require('fs');
const path = require('path');

/** 日志级别 */
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/** 当前日志级别 */
let currentLevel = LEVELS.INFO;

/** 日志文件路径 */
const LOG_DIR = path.join(__dirname, '..', 'logs');

/**
 * 设置日志级别
 * @param {string} level - 'DEBUG'|'INFO'|'WARN'|'ERROR'
 */
function setLevel(level) {
  currentLevel = LEVELS[level.toUpperCase()] || LEVELS.INFO;
}

/**
 * 获取指定名称的 logger
 * @param {string} name - 模块名称
 * @returns {Object} logger 对象 { info, warn, error, debug }
 */
function getLogger(name) {
  return {
    info: (msg) => log('INFO', name, msg),
    warn: (msg) => log('WARN', name, msg),
    error: (msg) => log('ERROR', name, msg),
    debug: (msg) => log('DEBUG', name, msg)
  };
}

/**
 * 写入日志
 * @param {string} level - 日志级别
 * @param {string} name - 模块名称
 * @param {string} msg - 日志消息
 */
function log(level, name, msg) {
  if (LEVELS[level] < currentLevel) return;

  const time = new Date().toLocaleString('zh-CN');
  const line = `[${time}] [${level}] [${name}] ${msg}`;

  // 控制台输出
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }

  // 写入日志文件
  writeToFile(line);
}

/**
 * 写入日志文件（按日期分文件）
 * @param {string} line - 日志行
 */
function writeToFile(line) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(LOG_DIR, `${date}.log`);
    fs.appendFileSync(filePath, line + '\n');
  } catch (e) {
    // 日志写入失败不影响主流程
  }
}

module.exports = { getLogger, setLevel };
