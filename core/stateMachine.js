/**
 * 全局执行状态机
 *
 * 设计目标：
 *   1. 任何时刻可读取当前真实执行节点
 *   2. 状态变更全程持久化到磁盘（崩溃后可恢复）
 *   3. 完整记录历史轨迹，便于排查
 *   4. 提供合法的"下一步"自动计算能力
 *
 * 状态定义（与 scheduler.js 保持兼容 + 扩展恢复相关）：
 *   IDLE          - 空闲
 *   SEARCHING     - 搜索中
 *   MONITORING    - 监控中
 *   PAUSED        - 已暂停
 *   ERROR         - 异常（等待恢复）
 *   RECOVERING    - 正在回退/重定位
 */

const fs = require('fs');
const path = require('path');
const { getLogger } = require('./logger');

const logger = getLogger('StateMachine');

const STATE_DIR = path.join(__dirname, '..', 'logs');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const HISTORY_FILE = path.join(STATE_DIR, 'state-history.jsonl');
const MAX_HISTORY = 1000;           // 历史记录最大条数（环形覆盖）
const SAVE_DEBOUNCE_MS = 300;       // 状态写盘防抖

const STATES = {
  IDLE: 'idle',
  SEARCHING: 'searching',
  MONITORING: 'monitoring',
  PAUSED: 'paused',
  ERROR: 'error',
  RECOVERING: 'recovering'
};

/**
 * 合法状态转移图（用于下一步自动计算 + 越权检测）
 */
const TRANSITIONS = {
  idle:         ['searching', 'monitoring', 'paused'],
  searching:    ['paused', 'idle', 'error', 'recovering'],
  monitoring:   ['paused', 'idle', 'error', 'recovering'],
  paused:       ['searching', 'monitoring', 'idle', 'recovering'],
  error:        ['recovering', 'idle'],
  recovering:   ['idle', 'searching', 'monitoring', 'error']
};

class StateMachine {
  constructor() {
    /** @type {string} 当前状态 */
    this.current = STATES.IDLE;
    /** @type {string} 当前阶段（细粒度，如 'loading_video'/'reading_comments'） */
    this.phase = 'boot';
    /** @type {string|null} 当前任务的唯一 ID（搜索/监控） */
    this.taskId = null;
    /** @type {string|null} 任务描述（如博主昵称 / 关键词） */
    this.taskDesc = null;
    /** @type {Object} 任务上下文（博主、关键词、索引等） */
    this.context = {};
    /** @type {string|null} 最后一次错误 */
    this.lastError = null;
    /** @type {string|null} 上一个稳定状态（用于回退目标） */
    this.lastStable = STATES.IDLE;
    /** @type {number} 状态时间戳 */
    this.updatedAt = 0;
    /** @type {Array} 历史记录 */
    this.history = [];
    /** 写盘防抖 */
    this._saveTimer = null;
    this._saving = false;

    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
  }

  /**
   * 从磁盘恢复状态（应用启动时调用）
   */
  _load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const saved = JSON.parse(raw);
        // 仅恢复上下文，不自动恢复中间态（避免僵尸任务）
        this.context = saved.context || {};
        this.taskId = saved.taskId || null;
        this.taskDesc = saved.taskDesc || null;
        this.lastStable = saved.lastStable || STATES.IDLE;
        this.phase = saved.phase || 'boot';
        // 如果上次在中间态被中断，强制重置为 IDLE 并记录
        if ([STATES.SEARCHING, STATES.MONITORING, STATES.PAUSED, STATES.RECOVERING].includes(saved.current)) {
          this._recordHistory('recovery_from_crash', saved.current, STATES.IDLE, { reason: '异常退出' });
          this.current = STATES.IDLE;
        } else {
          this.current = saved.current || STATES.IDLE;
        }
        logger.info(`状态机恢复: ${this.current} phase=${this.phase} task=${this.taskDesc || '-'}`);
      }
    } catch (e) {
      logger.warn(`状态机恢复失败: ${e.message}`);
    }
  }

  /**
   * 原子写入状态文件（写临时文件 + rename）
   */
  _save() {
    if (this._saving) {
      this._scheduleSave();
      return;
    }
    this._saving = true;
    try {
      const tmp = STATE_FILE + '.tmp';
      const data = {
        current: this.current,
        phase: this.phase,
        taskId: this.taskId,
        taskDesc: this.taskDesc,
        context: this.context,
        lastError: this.lastError,
        lastStable: this.lastStable,
        updatedAt: this.updatedAt
      };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      logger.error(`状态写盘失败: ${e.message}`);
    } finally {
      this._saving = false;
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * 记录状态变更历史（环形覆盖，JSONL 格式）
   */
  _recordHistory(action, from, to, extra = {}) {
    const entry = {
      ts: Date.now(),
      time: new Date().toLocaleString('zh-CN'),
      action,
      from,
      to,
      phase: this.phase,
      taskId: this.taskId,
      taskDesc: this.taskDesc,
      ...extra
    };
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    // 追加写入历史文件
    try {
      fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (e) {
      // 历史写入失败不影响主流程
    }
    logger.info(`[状态机] ${action}: ${from} -> ${to} phase=${this.phase} task=${this.taskDesc || '-'}`);
  }

  /**
   * 切换状态
   * @param {string} newState - 目标状态
   * @param {Object} options - { phase?, taskId?, taskDesc?, context?, error? }
   * @returns {boolean} 是否成功切换
   */
  transition(newState, options = {}) {
    if (!Object.values(STATES).includes(newState)) {
      logger.error(`非法状态: ${newState}`);
      return false;
    }
    const allowed = TRANSITIONS[this.current] || [];
    if (!allowed.includes(newState) && this.current !== newState) {
      logger.warn(`非法状态转移: ${this.current} -> ${newState}（已强制）`);
    }
    const from = this.current;
    this.current = newState;
    if (options.phase) this.phase = options.phase;
    if (options.taskId !== undefined) this.taskId = options.taskId;
    if (options.taskDesc !== undefined) this.taskDesc = options.taskDesc;
    if (options.context) this.context = { ...this.context, ...options.context };
    if (options.error !== undefined) this.lastError = options.error;
    this.updatedAt = Date.now();

    // 记录稳定状态（用于回退目标）
    if (newState === STATES.IDLE || newState === STATES.PAUSED) {
      this.lastStable = newState;
    }

    this._recordHistory('transition', from, newState, {
      error: options.error,
      context: options.context
    });
    this._scheduleSave();
    return true;
  }

  /**
   * 更新阶段（细粒度，不切换主状态）
   * @param {string} phase
   * @param {Object} [contextPatch]
   */
  setPhase(phase, contextPatch = {}) {
    this.phase = phase;
    if (contextPatch && Object.keys(contextPatch).length > 0) {
      this.context = { ...this.context, ...contextPatch };
    }
    this.updatedAt = Date.now();
    this._scheduleSave();
  }

  /**
   * 标记错误
   * @param {string} error - 错误描述
   * @param {Object} [extra]
   */
  setError(error, extra = {}) {
    this.lastError = error;
    this.context = { ...this.context, lastErrorAt: Date.now(), lastErrorExtra: extra };
    this._recordHistory('error', this.current, this.current, { error, ...extra });
    this._scheduleSave();
  }

  /**
   * 计算当前状态下的合法下一步动作
   * @returns {Array<{action: string, description: string}>}
   */
  getNextActions() {
    const actions = [];
    switch (this.current) {
      case STATES.IDLE:
        actions.push({ action: 'start_search', description: '启动搜索任务' });
        actions.push({ action: 'start_monitor', description: '启动监控任务' });
        actions.push({ action: 'show_stats', description: '查看统计数据' });
        break;
      case STATES.SEARCHING:
        actions.push({ action: 'pause', description: '暂停搜索' });
        actions.push({ action: 'stop', description: '停止搜索' });
        actions.push({ action: 'show_progress', description: '查看进度' });
        break;
      case STATES.MONITORING:
        actions.push({ action: 'pause', description: '暂停监控' });
        actions.push({ action: 'stop', description: '停止监控' });
        break;
      case STATES.PAUSED:
        actions.push({ action: 'resume', description: '恢复任务' });
        actions.push({ action: 'stop', description: '停止任务' });
        break;
      case STATES.ERROR:
        actions.push({ action: 'recover', description: '执行回退恢复' });
        actions.push({ action: 'reset', description: '强制重置为 IDLE' });
        break;
      case STATES.RECOVERING:
        actions.push({ action: 'wait', description: '等待恢复完成' });
        break;
    }
    return actions;
  }

  /**
   * 获取当前快照（用于 HTTP API / UI 展示）
   */
  snapshot() {
    return {
      current: this.current,
      phase: this.phase,
      taskId: this.taskId,
      taskDesc: this.taskDesc,
      context: this.context,
      lastError: this.lastError,
      lastStable: this.lastStable,
      updatedAt: this.updatedAt,
      nextActions: this.getNextActions(),
      recentHistory: this.history.slice(-20)
    };
  }

  /**
   * 强制重置（清空任务上下文，回到 IDLE）
   * 用于"放弃当前任务"或"恢复卡死"
   */
  forceReset(reason = 'manual') {
    const from = this.current;
    this.current = STATES.IDLE;
    this.phase = 'idle';
    this.taskId = null;
    this.taskDesc = null;
    this.context = {};
    this.lastError = null;
    this.updatedAt = Date.now();
    this._recordHistory('force_reset', from, STATES.IDLE, { reason });
    this._save();
  }

  /**
   * 应用退出前同步刷盘
   */
  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._save();
  }
}

// 单例
let instance = null;
function getStateMachine() {
  if (!instance) instance = new StateMachine();
  return instance;
}

module.exports = { getStateMachine, STATES, TRANSITIONS };
