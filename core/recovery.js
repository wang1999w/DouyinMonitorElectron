/**
 * 故障自愈与回退重定位模块
 *
 * 核心职责：
 *   1. 遇到阻塞类异常 → 立即执行回退（撤销当前操作、清空缓存、重置页面/CDP状态）
 *   2. 回退到上一个稳定状态
 *   3. 自动重定位到流程中下一个合法动作
 *   4. 持续失败计数，超过阈值则进入"待人工介入"状态
 *
 * 设计原则：
 *   - 任何回退操作都是幂等的（多次执行结果一致）
 *   - 不会强行向下执行破坏性操作
 *   - 失败上限可配置，超过后拒绝自动恢复
 */

const { getStateMachine, STATES } = require('./stateMachine');
const { getErrorAnalyzer, CATEGORIES, SEVERITY } = require('./errorAnalyzer');
const { getCDPInterceptor, getDouyinView } = require('../main/window');
const { getLogger } = require('./logger');

const logger = getLogger('Recovery');

const RECOVERY_CONFIG = {
  // 同一错误类别在 60s 内最多自动恢复次数
  MAX_RECOVERY_PER_CATEGORY: 3,
  // 总连续恢复失败次数上限（超过后强制 IDLE + 人工）
  MAX_TOTAL_RECOVERY: 10,
  // 恢复间隔（ms），避免频繁重试
  RECOVERY_COOLDOWN_MS: 3000,
  // 时间窗口
  RECOVERY_WINDOW_MS: 60000
};

class RecoveryManager {
  constructor() {
    /** @type {Array<{category: string, ts: number}>} */
    this.recoveryLog = [];
    /** @type {number} 连续恢复失败计数 */
    this.consecutiveFailures = 0;
    /** @type {boolean} 正在恢复中（避免并发） */
    this.recovering = false;
    /** @type {string|null} 上次恢复的错误类别 */
    this.lastRecoveryCategory = null;
  }

  /**
   * 触发自动恢复
   * @param {AnalyzedError} analyzedError
   * @param {Object} [context]
   * @returns {Promise<{recovered: boolean, action: string, needManual: boolean}>}
   */
  async autoRecover(analyzedError, context = {}) {
    if (this.recovering) {
      logger.warn('已有恢复任务进行中，拒绝并发');
      return { recovered: false, action: 'skip', needManual: false };
    }

    const state = getStateMachine();

    // 1. 频次检查
    const overLimit = this._isOverLimit(analyzedError.category);
    if (overLimit) {
      logger.error(`[${analyzedError.category}] 恢复次数超限，强制 IDLE 等待人工介入`);
      state.transition(STATES.IDLE, {
        error: `恢复次数超限：${analyzedError.category}`,
        context: { reason: 'recovery_overlimit' }
      });
      this.consecutiveFailures = 0;
      return { recovered: false, action: 'force_idle', needManual: true };
    }

    this.recovering = true;
    state.transition(STATES.RECOVERING, {
      error: analyzedError.message,
      context: { category: analyzedError.category }
    });

    try {
      // 2. 按错误类别执行回退
      const rollbackResult = await this._rollback(analyzedError, context);
      logger.info(`回退完成: ${rollbackResult.action}`);

      // 3. 重定位
      const next = this._relocate(analyzedError, context);
      logger.info(`重定位到: ${JSON.stringify(next)}`);

      // 4. 记录
      this._recordRecovery(analyzedError.category);
      this.consecutiveFailures = 0;

      // 5. 状态推进
      if (next.targetState) {
        state.transition(next.targetState, {
          phase: next.phase,
          context: next.contextPatch
        });
      } else {
        state.transition(state.lastStable, { phase: 'idle' });
      }

      return { recovered: true, action: rollbackResult.action, next, needManual: false };
    } catch (e) {
      this.consecutiveFailures++;
      logger.error(`恢复过程失败: ${e.message}`);
      state.setError(`恢复失败: ${e.message}`);
      if (this.consecutiveFailures >= RECOVERY_CONFIG.MAX_TOTAL_RECOVERY) {
        state.transition(STATES.IDLE, { error: '连续恢复失败，已强制 IDLE' });
        this.consecutiveFailures = 0;
        return { recovered: false, action: 'give_up', needManual: true };
      }
      return { recovered: false, action: 'retry_later', needManual: false };
    } finally {
      this.recovering = false;
    }
  }

  /**
   * 回退操作（按错误类别分发）
   * @private
   */
  async _rollback(err, context) {
    const actions = [];
    const cdp = getCDPInterceptor();
    const view = getDouyinView();

    switch (err.category) {
      case CATEGORIES.BROWSER_CRASHED:
        // 重置 CDP、CDP 会随浏览器重建
        if (cdp && typeof cdp.reset === 'function') cdp.reset();
        actions.push('cdp_reset');
        return { action: actions.join('+') };

      case CATEGORIES.CDP_DETACHED:
        if (cdp && typeof cdp.reset === 'function') cdp.reset();
        actions.push('cdp_reinit');
        return { action: actions.join('+') };

      case CATEGORIES.PAGE_LOAD:
      case CATEGORIES.NAVIGATION:
        // 回到上次稳定页面
        if (view && view.webContents && !view.webContents.isDestroyed()) {
          try {
            await view.webContents.stop();
            actions.push('stop_navigation');
          } catch (_) {}
        }
        return { action: actions.join('+') };

      case CATEGORIES.NETWORK:
      case CATEGORIES.TIMEOUT:
        // 等待网络恢复 + 清理当前任务临时缓存
        await this._sleep(2000);
        if (context.aid && cdp && typeof cdp.endCollect === 'function') {
          cdp.endCollect(context.aid);
          actions.push('cdp_end_collect');
        }
        return { action: actions.join('+') };

      case CATEGORIES.CAPTCHA:
        // 不自动继续，等待人工
        actions.push('wait_manual');
        return { action: actions.join('+') };

      case CATEGORIES.AUTH_REQUIRED:
        // 撤销当前任务，回到 IDLE
        actions.push('goto_login');
        return { action: actions.join('+') };

      case CATEGORIES.JSON_PARSE:
        // 清空当前视频的 CDP 缓存
        if (context.aid && cdp && typeof cdp.endCollect === 'function') {
          cdp.endCollect(context.aid);
          actions.push('cdp_end_collect');
        }
        actions.push('skip_video');
        return { action: actions.join('+') };

      case CATEGORIES.DATA_MISSING:
      case CATEGORIES.ELEMENT_NOT_FOUND:
        // 跳过当前元素，继续下一个
        actions.push('skip_current');
        return { action: actions.join('+') };

      default:
        // 未知错误：保守回退
        if (cdp && typeof cdp.reset === 'function') cdp.reset();
        actions.push('soft_reset');
        return { action: actions.join('+') };
    }
  }

  /**
   * 重定位：计算下一步合法动作
   * @private
   */
  _relocate(err, context) {
    const state = getStateMachine();

    // 致命级错误直接 IDLE
    if (err.severity === SEVERITY.FATAL) {
      return { targetState: STATES.IDLE, phase: 'idle', contextPatch: { reason: 'fatal_error' } };
    }

    // 验证码/鉴权需要人工
    if (err.category === CATEGORIES.CAPTCHA || err.category === CATEGORIES.AUTH_REQUIRED) {
      return { targetState: STATES.PAUSED, phase: 'waiting_manual', contextPatch: { reason: err.category } };
    }

    // 普通错误：在当前任务中继续
    const current = state.current;
    if (current === STATES.SEARCHING) {
      return { targetState: STATES.SEARCHING, phase: 'continue_next_video', contextPatch: { skipCurrentAid: context.aid } };
    }
    if (current === STATES.MONITORING) {
      return { targetState: STATES.MONITORING, phase: 'continue_monitoring', contextPatch: {} };
    }

    return { targetState: STATES.IDLE, phase: 'idle', contextPatch: {} };
  }

  _isOverLimit(category) {
    const now = Date.now();
    // 清理窗口外
    this.recoveryLog = this.recoveryLog.filter(r => now - r.ts < RECOVERY_CONFIG.RECOVERY_WINDOW_MS);
    const sameCategory = this.recoveryLog.filter(r => r.category === category).length;
    return sameCategory >= RECOVERY_CONFIG.MAX_RECOVERY_PER_CATEGORY;
  }

  _recordRecovery(category) {
    this.recoveryLog.push({ category, ts: Date.now() });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * 获取恢复统计（用于 HTTP API）
   */
  getStats() {
    return {
      consecutiveFailures: this.consecutiveFailures,
      recovering: this.recovering,
      recentCount: this.recoveryLog.length,
      lastCategory: this.lastRecoveryCategory
    };
  }

  /**
   * 强制重置（人工重置后）
   */
  reset() {
    this.recoveryLog = [];
    this.consecutiveFailures = 0;
    this.recovering = false;
  }
}

let instance = null;
function getRecoveryManager() {
  if (!instance) instance = new RecoveryManager();
  return instance;
}

module.exports = { getRecoveryManager, RECOVERY_CONFIG };
