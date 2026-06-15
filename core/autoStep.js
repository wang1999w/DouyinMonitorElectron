/**
 * 自动化操作框架
 * 核心原则：
 *   1. 每步操作后验证结果，不跳过
 *   2. 失败自动重试，最多3次
 *   3. 重试失败后尝试替代方案
 *   4. 所有异常记录日志并通知
 *   5. 关键步骤失败终止任务，不带错执行
 */

const { getLogger } = require('./logger');
const logger = getLogger('AutoStep');

/**
 * 执行一个自动化步骤
 * @param {string} name - 步骤名称
 * @param {Function} action - 执行函数，返回 truthy 表示成功
 * @param {Function} verify - 验证函数，返回 truthy 表示验证通过
 * @param {Object} options - { retries: 3, fallback: Function, timeout: 10000, log: Function }
 * @returns {Promise<boolean>} 是否成功
 */
async function step(name, action, verify, options = {}) {
  const { retries = 3, fallback = null, timeout = 10000, log = null } = options;
  const doLog = log || ((msg) => logger.info(msg));

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      doLog(`  [${name}] 执行 (第${attempt}次)...`);

      // 执行操作
      const result = await withTimeout(action(), timeout, `${name} 执行超时`);

      // 验证结果
      if (verify) {
        const verified = await withTimeout(verify(), timeout, `${name} 验证超时`);
        if (verified) {
          doLog(`  [${name}] ✓ 成功`);
          return true;
        }
        doLog(`  [${name}] 验证未通过 (第${attempt}次)`);
      } else {
        // 无验证函数，依赖 action 返回值
        if (result) {
          doLog(`  [${name}] ✓ 成功`);
          return true;
        }
        doLog(`  [${name}] 执行结果为空 (第${attempt}次)`);
      }
    } catch (e) {
      doLog(`  [${name}] 异常: ${e.message} (第${attempt}次)`);
    }

    // 重试前等待
    if (attempt < retries) {
      await sleep(1000, 2000);
    }
  }

  // 所有重试失败，尝试替代方案
  if (fallback) {
    try {
      doLog(`  [${name}] 尝试替代方案...`);
      await fallback();
      if (verify) {
        const verified = await withTimeout(verify(), timeout, `${name} 替代方案验证超时`);
        if (verified) {
          doLog(`  [${name}] ✓ 替代方案成功`);
          return true;
        }
      }
    } catch (e) {
      doLog(`  [${name}] 替代方案也失败: ${e.message}`);
    }
  }

  doLog(`  [${name}] ✗ 最终失败`);
  return false;
}

/**
 * 带超时的 Promise
 */
function withTimeout(promise, ms, errorMsg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMsg)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * 等待条件成立
 * @param {Function} condition - 返回 truthy 表示条件成立
 * @param {number} timeout - 超时毫秒
 * @param {number} interval - 检查间隔毫秒
 */
async function waitFor(condition, timeout = 10000, interval = 500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const result = await condition();
      if (result) return result;
    } catch (e) {}
    await sleep(interval);
  }
  return null;
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { step, waitFor, withTimeout, sleep };
