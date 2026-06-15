/**
 * 智能步骤执行器
 *
 * 核心理念：程序必须知道自己在做什么
 *
 * 每个步骤执行前：
 *   1. 检查当前页面状态（在哪一页？有什么元素？）
 *   2. 确认前置条件满足
 *   3. 执行操作
 *   4. 验证操作结果
 *   5. 如果失败：诊断原因 → 选择补救策略
 *
 * 失败原因分类：
 *   - element_not_found: 元素不存在（页面结构变化/未加载）
 *   - element_hidden: 元素被遮挡/不可见
 *   - page_wrong: 在错误的页面
 *   - captcha: 验证码拦截
 *   - timeout: 操作超时
 *   - network: 网络问题
 *
 * 补救策略：
 *   - retry: 重试（可能是时序问题）
 *   - refresh: 刷新页面后重试
 *   - navigate: 导航到正确页面后重试
 *   - wait_user: 等待用户处理（验证码/登录）
 *   - skip: 跳过当前步骤
 *   - abort: 终止任务
 */

const { getLogger } = require('./logger');
const logger = getLogger('SmartStep');

/**
 * 执行一个智能步骤
 * @param {string} name - 步骤名称
 * @param {Function} action - 执行函数
 * @param {Function} verify - 验证函数（返回 { success, reason, data }）
 * @param {Object} options
 * @param {Function} options.getPageState - 获取当前页面状态
 * @param {Function} options.onFail - 失败时的诊断回调
 * @param {number} options.retries - 最大重试次数
 * @param {number} options.timeout - 超时时间
 * @param {Function} options.log - 日志回调
 * @returns {Promise<{success: boolean, data?: any}>}
 */
async function smartStep(name, action, verify, options = {}) {
  const {
    getPageState = null,
    onFail = null,
    retries = 3,
    timeout = 10000,
    log = (msg) => logger.info(msg)
  } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    log(`  [${name}] 第${attempt}次尝试...`);

    try {
      // 1. 检查当前状态（可选）
      if (getPageState) {
        const state = await withTimeout(getPageState(), 5000, '状态检查超时');
        log(`    页面状态: ${JSON.stringify(state).substring(0, 100)}`);
      }

      // 2. 执行操作
      const actionResult = await withTimeout(action(), timeout, `${name} 执行超时`);

      // 3. 验证结果
      if (verify) {
        const vr = await withTimeout(verify(), 5000, `${name} 验证超时`);

        if (vr.success) {
          log(`    ✓ ${name} 成功${vr.data ? ': ' + JSON.stringify(vr.data).substring(0, 80) : ''}`);
          return { success: true, data: vr.data };
        }

        // 4. 诊断失败原因
        const diagnosis = vr.reason || 'unknown';
        log(`    ✗ ${name} 失败: ${diagnosis}`);

        if (onFail) {
          const recovery = await onFail(diagnosis, attempt);
          if (recovery === 'abort') {
            log(`    🛑 ${name} 终止任务`);
            return { success: false, reason: diagnosis };
          }
          if (recovery === 'skip') {
            log(`    ⏭ ${name} 跳过`);
            return { success: false, reason: 'skipped' };
          }
          if (recovery === 'wait_user') {
            log(`    ⏸ ${name} 等待用户处理...`);
            await sleep(5000);
            continue; // 等待后重试
          }
          // recovery === 'retry' 或默认：继续重试
        }
      } else {
        // 无验证函数，依赖 action 返回值
        if (actionResult) {
          log(`    ✓ ${name} 成功`);
          return { success: true, data: actionResult };
        }
        log(`    ✗ ${name} 执行结果为空`);
      }
    } catch (e) {
      log(`    ⚠ ${name} 异常: ${e.message}`);
    }

    // 重试前等待
    if (attempt < retries) {
      log(`    等待后重试...`);
      await sleep(1000, 2000);
    }
  }

  log(`    🛑 ${name} ${retries}次重试均失败`);
  return { success: false, reason: 'max_retries' };
}

/**
 * 获取页面状态快照
 * 用于诊断当前在什么页面、有什么元素
 */
async function getPageSnapshot(wc) {
  try {
    return await wc.executeJavaScript(`(function(){
      const url = location.href;
      const title = document.title;
      const body = document.body.innerText.substring(0, 300);

      // 检查关键元素
      const hasSearchInput = !!document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
      const hasSearchBtn = !!document.querySelector('[data-e2e="searchbar-button"]');
      const hasVideoTab = !!(function(){ for(const el of document.querySelectorAll('*')){ if((el.innerText||'').trim()==='视频'){ const r=el.getBoundingClientRect(); if(r.width>10&&r.height<50&&r.y>30&&r.y<200) return true; } } return false; })();
      const hasFilterBtn = !!(function(){ for(const el of document.querySelectorAll('*')){ const t=(el.innerText||'').trim(); if(t.includes('筛选')&&!t.includes('筛选结果')){ const r=el.getBoundingClientRect(); if(r.width>20&&r.width<120&&r.y>30&&r.y<250) return true; } } return false; })();
      const hasCaptcha = body.includes('请完成下列验证') || body.includes('拖动完成拼图');
      const hasLogin = body.includes('登录') && body.length < 200;

      // 视频链接数
      const vids = new Set();
      document.querySelectorAll('a[href*="/video/"]').forEach(a => {
        const m = (a.getAttribute('href')||'').match(/\\/video\\/(\\d+)/);
        if (m) vids.add(m[1]);
      });

      return {
        url, title,
        hasSearchInput, hasSearchBtn, hasVideoTab, hasFilterBtn,
        hasCaptcha, hasLogin,
        videoCount: vids.size,
        bodySnippet: body.substring(0, 100)
      };
    })()`).catch(() => null);
  } catch (e) {
    return null;
  }
}

/**
 * 分析页面状态，判断当前在什么阶段
 */
function analyzePageState(state) {
  if (!state) return { phase: 'unknown', issue: '无法获取页面状态' };

  if (state.hasCaptcha) return { phase: 'captcha', issue: '验证码拦截' };
  if (state.hasLogin) return { phase: 'need_login', issue: '需要登录' };

  // 在搜索结果页
  if (state.url.includes('search') || state.title.includes('搜索')) {
    if (state.hasVideoTab && state.hasFilterBtn) {
      return { phase: 'search_results', issue: null, videoCount: state.videoCount };
    }
    return { phase: 'search_loading', issue: '搜索结果页加载中' };
  }

  // 在首页
  if (state.hasSearchInput && state.hasSearchBtn) {
    return { phase: 'homepage', issue: null };
  }

  return { phase: 'unknown', issue: `未知页面: ${state.title}` };
}

async function withTimeout(promise, ms, errorMsg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMsg)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { smartStep, getPageSnapshot, analyzePageState };
