/**
 * 错误分析与根因分类器
 *
 * 设计目标：
 *   1. 所有浏览器操作、网络抓包、接口请求、数据解析报错统一入口
 *   2. 自动分类：401 鉴权、页面加载失败、JSON 解析异常、网络中断、数据缺失、验证码等
 *   3. 输出结构化诊断信息（类别 / 严重度 / 建议处理）
 *   4. 完整错误上下文（不输出空白 / 无意义错误）
 */

const { getLogger } = require('./logger');
const logger = getLogger('ErrorAnalyzer');

/**
 * 错误类别常量
 */
const CATEGORIES = {
  AUTH_REQUIRED: 'auth_required',                  // 401 / 需要登录
  CAPTCHA: 'captcha',                              // 验证码
  PAGE_LOAD: 'page_load',                          // 页面加载失败
  TIMEOUT: 'timeout',                              // 操作超时
  NAVIGATION: 'navigation',                        // 导航异常
  JSON_PARSE: 'json_parse',                        // JSON 解析失败
  NETWORK: 'network',                              // 网络中断 / DNS / 连接失败
  CDP_DETACHED: 'cdp_detached',                    // CDP 调试器断开
  DATA_MISSING: 'data_missing',                    // 数据缺失（评论为 0 等）
  ELEMENT_NOT_FOUND: 'element_not_found',          // 找不到 DOM 元素
  BROWSER_CRASHED: 'browser_crashed',              // 渲染进程崩溃
  IPC_FAILED: 'ipc_failed',                        // IPC 通信失败
  UNKNOWN: 'unknown'
};

/**
 * 严重度
 */
const SEVERITY = {
  INFO: 'info',          // 提示（如"无评论"）
  WARN: 'warn',          // 警告（重试可恢复）
  ERROR: 'error',        // 错误（需要恢复策略）
  FATAL: 'fatal'         // 致命（需要回退 + 重定位）
};

/**
 * 错误分类规则（按优先级匹配）
 */
const RULES = [
  // ---------- 致命：浏览器/渲染崩溃 ----------
  { test: /render process gone|render-process-gone|browser crashed|unresponsive/i, category: CATEGORIES.BROWSER_CRASHED, severity: SEVERITY.FATAL, suggestion: '渲染进程崩溃，需要重启浏览器视图' },
  { test: /debugger.*detached|cdp.*detach|webContents.*destroyed/i, category: CATEGORIES.CDP_DETACHED, severity: SEVERITY.ERROR, suggestion: 'CDP 调试器断开，需要重新注入' },

  // ---------- 错误：鉴权 / 验证码 ----------
  { test: /401|unauthorized|未登录|请先登录|登录已过期|token.*expired/i, category: CATEGORIES.AUTH_REQUIRED, severity: SEVERITY.ERROR, suggestion: '需要重新登录抖音账号' },
  { test: /captcha|verify|验证|人机|滑块|拖动|拼图/i, category: CATEGORIES.CAPTCHA, severity: SEVERITY.WARN, suggestion: '需要人工完成验证码' },

  // ---------- 错误：页面加载 ----------
  { test: /net::ERR_|ENOTFOUND|ENETUNREACH|ECONNRESET|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i, category: CATEGORIES.NETWORK, severity: SEVERITY.ERROR, suggestion: '网络异常，检查本地网络连接' },
  { test: /timeout|timed out|超时/i, category: CATEGORIES.TIMEOUT, severity: SEVERITY.WARN, suggestion: '操作超时，建议重试' },
  { test: /ERR_ABORTED|ERR_FAILED|ERR_INVALID|ERR_EMPTY_RESPONSE|ERR_CONNECTION/i, category: CATEGORIES.NETWORK, severity: SEVERITY.ERROR, suggestion: '网络请求失败，建议稍后重试' },
  { test: /did-fail-load|page load.*fail|loadURL.*fail/i, category: CATEGORIES.PAGE_LOAD, severity: SEVERITY.ERROR, suggestion: '页面加载失败，检查 URL 与网络' },
  { test: /ERR_NAME_NOT_RESOLVED|certificate|SSL|TLS/i, category: CATEGORIES.NETWORK, severity: SEVERITY.ERROR, suggestion: 'DNS 或证书异常' },

  // ---------- 错误：数据解析 ----------
  { test: /JSON\.parse|SyntaxError.*JSON|Unexpected token.*JSON|parse error/i, category: CATEGORIES.JSON_PARSE, severity: SEVERITY.WARN, suggestion: '接口返回非 JSON 格式，可能被风控拦截' },
  { test: /Cannot read prop|undefined is not|cannot read|of undefined|null is not/i, category: CATEGORIES.DATA_MISSING, severity: SEVERITY.WARN, suggestion: '数据结构异常，字段缺失' },

  // ---------- 警告：元素查找 ----------
  { test: /querySelector.*null|element.*not found|selector.*not match|未找到/i, category: CATEGORIES.ELEMENT_NOT_FOUND, severity: SEVERITY.WARN, suggestion: '页面结构变化，选择器失效' },

  // ---------- 错误：导航 ----------
  { test: /navigation|will-navigate|navigate.*prevent|导航.*失败/i, category: CATEGORIES.NAVIGATION, severity: SEVERITY.WARN, suggestion: '导航被拦截，检查目标 URL' },

  // ---------- 错误：IPC ----------
  { test: /IPC|ipcMain|invoke.*fail|ipcRenderer/i, category: CATEGORIES.IPC_FAILED, severity: SEVERITY.ERROR, suggestion: '主进程通信失败' },

  // ---------- 兜底 ----------
  { test: /.*/, category: CATEGORIES.UNKNOWN, severity: SEVERITY.WARN, suggestion: '未分类错误，查看堆栈' }
];

/**
 * 增强的错误对象
 */
class AnalyzedError extends Error {
  constructor(message, analysis) {
    super(message);
    this.name = 'AnalyzedError';
    this.category = analysis.category;
    this.severity = analysis.severity;
    this.suggestion = analysis.suggestion;
    this.timestamp = analysis.timestamp;
    this.context = analysis.context;
    this.originalStack = analysis.stack;
  }

  /**
   * 序列化为可存储的格式
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      severity: this.severity,
      suggestion: this.suggestion,
      timestamp: this.timestamp,
      context: this.context,
      stack: this.originalStack
    };
  }

  /**
   * 人类可读的多行输出
   */
  format() {
    const lines = [
      `[${this.severity.toUpperCase()}] ${this.category}`,
      `原因: ${this.message}`,
      `建议: ${this.suggestion}`,
      `时间: ${this.timestamp}`
    ];
    if (this.context && Object.keys(this.context).length > 0) {
      lines.push(`上下文: ${JSON.stringify(this.context)}`);
    }
    if (this.originalStack) {
      lines.push(`堆栈: ${this.originalStack.split('\n').slice(0, 3).join(' | ')}`);
    }
    return lines.join('\n');
  }
}

/**
 * 错误分析器主类
 */
class ErrorAnalyzer {
  constructor() {
    /** 错误历史（环形） */
    this.history = [];
    this.maxHistory = 200;
  }

  /**
   * 分析错误
   * @param {Error|string} err
   * @param {Object} [context] - 上下文（如 aid、url、phase）
   * @returns {AnalyzedError}
   */
  analyze(err, context = {}) {
    const message = (err && err.message) ? err.message : String(err);
    const stack = (err && err.stack) ? err.stack : new Error().stack;
    const timestamp = new Date().toISOString();

    let matched = RULES[RULES.length - 1]; // 默认 UNKNOWN
    for (const rule of RULES) {
      if (rule.test.test(message)) {
        matched = rule;
        break;
      }
    }

    const analysis = {
      category: matched.category,
      severity: matched.severity,
      suggestion: matched.suggestion,
      timestamp,
      context,
      stack
    };

    const analyzed = new AnalyzedError(message, analysis);
    this._record(analyzed);
    return analyzed;
  }

  _record(analyzed) {
    this.history.push(analyzed.toJSON());
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    // 严重错误立即日志
    if (analyzed.severity === SEVERITY.ERROR || analyzed.severity === SEVERITY.FATAL) {
      logger.error(`[${analyzed.category}] ${analyzed.message} → ${analyzed.suggestion}`);
    } else {
      logger.warn(`[${analyzed.category}] ${analyzed.message}`);
    }
  }

  /**
   * 包裹异步函数：自动捕获 + 分类 + 重抛
   * @param {Function} fn
   * @param {Object} [context]
   * @returns {Function}
   */
  wrap(fn, context = {}) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        throw this.analyze(e, context);
      }
    };
  }

  /**
   * 获取历史（用于 UI / HTTP）
   */
  getHistory(limit = 50) {
    return this.history.slice(-limit);
  }

  /**
   * 按类别统计
   */
  getStats() {
    const stats = {};
    for (const e of this.history) {
      stats[e.category] = (stats[e.category] || 0) + 1;
    }
    return stats;
  }

  /**
   * 清空历史
   */
  clear() {
    this.history = [];
  }
}

let instance = null;
function getErrorAnalyzer() {
  if (!instance) instance = new ErrorAnalyzer();
  return instance;
}

module.exports = {
  getErrorAnalyzer,
  CATEGORIES,
  SEVERITY,
  AnalyzedError
};
