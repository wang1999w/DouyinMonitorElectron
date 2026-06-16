/**
 * 智能操作层 v1.0 - 融合 SeleniumBase + puppeteer-stealth 最佳实践
 *
 * 设计目标:
 *   1. 显式等待代替硬性 sleep（element_to_be_clickable 三态）
 *   2. 多策略链式定位（best_match 思想 + 自动降级）
 *   3. 自动重试 + 退避（指数退避，最大 3 次）
 *   4. Bezier 曲线鼠标轨迹（puppeteer-extra 风格）
 *   5. 真人打字节奏（不规则 + 偶发错字）
 *   6. 完整失败诊断（dump 候选元素 + 截图路径）
 *
 * 关键 API:
 *   - waitForClickable(view, query, timeout)   - 三态检测显式等待
 *   - safeClick(view, query, options)          - 带等待+重试+诊断的点击
 *   - safeType(view, selector, text)           - 真人打字
 *   - safeScroll(view, dir, dist)              - 滚动
 *   - diagnoseNoMatch(view, query)             - 失败诊断 dump
 */

const { getLogger } = require('./logger');
const human = require('./humanBehavior');
const robustClick = require('./robustClick');
const pageInspector = require('./pageInspector');
const logger = getLogger('SmartOps');

const DEFAULT_TIMEOUT = 8000;
const DEFAULT_RETRY = 3;

/**
 * 元素三态检测（SeleniumBase EC.element_to_be_clickable 思想）
 * - presence: DOM 中存在
 * - visibility: 有尺寸且不在 display:none 容器
 * - enabled: 非 disabled / aria-disabled=true
 * - not-covered: 不被其它元素完全遮挡
 */
const TRIPLE_CHECK_SCRIPT = `(function(q){
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  function isVisible(el) {
    if (!el) return false;
    const r = rectOf(el);
    if (r.w <= 0 || r.h <= 0) return false;
    if (r.y < 0 || r.y > window.innerHeight) return false;
    if (r.x < 0 || r.x > window.innerWidth) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return true;
  }
  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled === true) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.getAttribute('disabled') !== null) return false;
    return true;
  }
  function isCovered(el) {
    if (!el) return { covered: true, reason: 'no_element' };
    const r = rectOf(el);
    if (r.w <= 0 || r.h <= 0) return { covered: true, reason: 'no_rect' };
    const x = r.x + r.w / 2;
    const y = r.y + r.h / 2;
    const top = document.elementFromPoint(x, y);
    if (!top) return { covered: true, reason: 'no_top_element' };
    // 命中元素本身或其祖先
    let cur = top;
    while (cur && cur !== document.body) {
      if (cur === el) return { covered: false, top: top.tagName.toLowerCase(), topText: (top.innerText||'').substring(0,20) };
      cur = cur.parentElement;
    }
    return { covered: true, reason: 'covered_by_other', top: top.tagName.toLowerCase(), topText: (top.innerText||'').substring(0,20) };
  }
  function findEl(q) {
    // 1. data-e2e 精确
    if (q.dataE2E) {
      const e = document.querySelector('[data-e2e="' + q.dataE2E + '"]');
      if (e) return e;
    }
    // 2. CSS 选择器
    if (q.selector) {
      const e = document.querySelector(q.selector);
      if (e) return e;
    }
    // 3. 文本
    if (q.text) {
      const all = document.querySelectorAll('span, div, a, button, li, p, h1, h2, h3, h4');
      for (const el of all) {
        if (el.children.length > 5) continue;
        const t = (el.innerText || el.textContent || '').trim();
        if (q.textMode === 'exact' && t === q.text) return el;
        if (q.textMode === 'startsWith' && t.startsWith(q.text)) return el;
        if ((!q.textMode || q.textMode === 'includes') && t.includes(q.text)) return el;
      }
    }
    return null;
  }
  const el = findEl(q);
  if (!el) return { state: 'absent', reason: 'not_found' };
  if (!isVisible(el)) return { state: 'invisible', reason: 'no_size_or_hidden' };
  if (!isEnabled(el)) return { state: 'disabled', reason: 'disabled_attr' };
  const cov = isCovered(el);
  if (cov.covered) {
    // 如果是 modal/popover/dialog 遮挡且非目标，常态；按 isEnabled/visible 已 OK
    return { state: 'covered', reason: cov.reason, top: cov.top, topText: cov.topText };
  }
  const r = rectOf(el);
  return {
    state: 'clickable',
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || '').trim().substring(0, 30),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) },
    center: { x: Math.round(r.x + r.w/2), y: Math.round(r.y + r.h/2) }
  };
})`;

/**
 * 显式等待元素可点击（SeleniumBase wait_for_element_clickable 思想）
 * @param {object} view - Electron BrowserView
 * @param {object} query - {dataE2E, selector, text, textMode}
 * @param {number} timeout - 毫秒
 * @returns {Promise<{state, ...}>}
 */
async function waitForClickable(view, query, timeout) {
  timeout = timeout || DEFAULT_TIMEOUT;
  const wc = view.webContents;
  const t0 = Date.now();
  let lastState = { state: 'absent', reason: 'init' };

  while (Date.now() - t0 < timeout) {
    try {
      const res = await wc.executeJavaScript(`(${TRIPLE_CHECK_SCRIPT})(${JSON.stringify(query)})`);
      if (res && res.state === 'clickable') return res;
      lastState = res || lastState;
    } catch (e) {
      lastState = { state: 'js_error', reason: e.message };
    }
    // 随机抖动 100-220ms，避免固定轮询特征
    await sleep(100 + Math.floor(Math.random() * 120));
  }
  return lastState;
}

/**
 * 安全点击（替代直接 mouseClick）
 * 流程：等待可点击 → mouseMove Bezier → pre-check 坐标 → mouseDown/Up → 后置校验
 *
 * @param {object} view
 * @param {object} query - {dataE2E, selector, text, textMode, x, y}
 * @param {object} options - {timeout, retries, requireStateChange, scrollIntoView}
 */
async function safeClick(view, query, options) {
  options = options || {};
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const retries = options.retries != null ? options.retries : DEFAULT_RETRY;
  const requireStateChange = options.requireStateChange !== false;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let target = null;

    // 1. 等待可点击
    if (query.x != null && query.y != null) {
      // 坐标模式：跳过 wait，信任调用方
      target = { center: { x: query.x, y: query.y } };
    } else {
      const state = await waitForClickable(view, query, timeout);
      if (state.state !== 'clickable') {
        logger.warn(`safeClick[${attempt}/${retries}]: not clickable: ${JSON.stringify(state)}`);
        await sleep(500 * attempt); // 退避
        continue;
      }
      target = state;
    }

    // 2. 滚动到视口（如果需要）
    if (options.scrollIntoView !== false) {
      try {
        await view.webContents.executeJavaScript(`(function(){
          const q = ${JSON.stringify(query)};
          let el = null;
          if (q.dataE2E) el = document.querySelector('[data-e2e="' + q.dataE2E + '"]');
          else if (q.selector) el = document.querySelector(q.selector);
          if (el && el.scrollIntoView) {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
          }
        })()`);
        await sleep(200);
      } catch (_) {}
    }

    // 3. 预检查坐标处的元素（防被遮挡）
    const x = target.center.x;
    const y = target.center.y;
    const preCheck = await view.webContents.executeJavaScript(`(function(){
      const top = document.elementFromPoint(${x}, ${y});
      if (!top) return { ok: false, reason: 'no_element_at_point' };
      const tag = top.tagName.toLowerCase();
      // 严禁在 input/textarea 上落点（除非调用方显式允许）
      if (tag === 'input' || tag === 'textarea') {
        return { ok: false, reason: 'would_hit_input', tag, type: top.type || '' };
      }
      return { ok: true, tag, text: (top.innerText || '').trim().substring(0, 30) };
    })()`);

    if (!preCheck.ok) {
      logger.warn(`safeClick[${attempt}/${retries}]: pre-check failed at (${x},${y}): ${preCheck.reason}`);
      await sleep(500 * attempt);
      continue;
    }

    // 4. 真实点击（Bezier 轨迹 + 抖动）
    await human.humanClick(view.webContents, x, y);
    await sleep(300);

    // 5. 后置校验：页面状态是否改变（URL / 弹层 / 文本变化）
    if (requireStateChange && options.expectedState) {
      await sleep(options.stateChangeDelay || 800);
      const changed = await checkStateChanged(view, options.expectedState);
      if (!changed.match) {
        logger.warn(`safeClick[${attempt}/${retries}]: state unchanged: ${changed.reason}`);
        await sleep(700 * attempt);
        continue;
      }
    }

    logger.info(`safeClick[${attempt}/${retries}] OK @(${x},${y}) tag=${preCheck.tag}`);
    return {
      success: true,
      attempt,
      x, y,
      landedOn: preCheck,
      target
    };
  }

  // 全部失败 → dump 诊断
  const diag = await diagnoseNoMatch(view, query);
  return {
    success: false,
    error: 'all_retries_failed',
    target: query,
    diagnostics: diag
  };
}

/**
 * 检查状态变化（后置校验）
 * options.expectedState 形如:
 *   { urlIncludes: 'search', urlExcludes: '?', textAppears: '视频', textDisappears: '加载', elementGone: '[class*="loading"]' }
 */
async function checkStateChanged(view, expected) {
  try {
    const wc = view.webContents;
    const r = await wc.executeJavaScript(`(function(){
      return {
        url: location.href,
        title: document.title,
        hasText: function(t) { return document.body.innerText.includes(t); }
      };
    })()`);
    if (expected.urlIncludes && !r.url.includes(expected.urlIncludes)) {
      return { match: false, reason: 'url_missing:' + expected.urlIncludes, current: r.url };
    }
    if (expected.urlExcludes && r.url.includes(expected.urlExcludes)) {
      return { match: false, reason: 'url_has:' + expected.urlExcludes, current: r.url };
    }
    if (expected.textAppears && !r.hasText(expected.textAppears)) {
      return { match: false, reason: 'text_missing:' + expected.textAppears };
    }
    if (expected.textDisappears && r.hasText(expected.textDisappears)) {
      return { match: false, reason: 'text_still:' + expected.textDisappears };
    }
    if (expected.elementGone) {
      const el = await wc.executeJavaScript(`(function(s){ return document.querySelector(s); })(${JSON.stringify(expected.elementGone)})`);
      if (el) return { match: false, reason: 'element_still:' + expected.elementGone };
    }
    return { match: true, current: r };
  } catch (e) {
    return { match: false, reason: 'check_error:' + e.message };
  }
}

/**
 * 失败诊断 - 列出页面上最接近的候选元素
 */
async function diagnoseNoMatch(view, query) {
  try {
    const candidates = await pageInspector.dumpClickableElements(view);
    return {
      query,
      candidatesCount: candidates.count || 0,
      topCandidates: (candidates.items || []).slice(0, 20)
    };
  } catch (e) {
    return { query, error: e.message };
  }
}

/**
 * 真人打字 - 不规则节奏 + 偶发错字修正
 */
async function safeType(view, selector, text) {
  const wc = view.webContents;

  // 1. 等待输入框可交互
  const state = await waitForClickable(view, { selector }, DEFAULT_TIMEOUT);
  if (state.state !== 'clickable') {
    // 退而求其次：接受 disabled/covered（输入框可能未聚焦）
    if (state.state === 'disabled' || state.state === 'covered') {
      logger.warn(`safeType: input not ideal (${state.state}), try anyway`);
    } else {
      return { success: false, error: 'input_not_found', state };
    }
  }

  // 2. focus
  try {
    await wc.executeJavaScript(`(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) { el.focus(); el.click(); }
    })()`);
  } catch (_) {}
  await sleep(200);

  // 3. 清空
  try {
    await wc.executeJavaScript(`(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    })()`);
    await sleep(150);
  } catch (_) {}

  // 4. 逐字打字（不规则节奏）
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const baseDelay = 80 + Math.random() * 140;     // 80-220ms 基础
    const burstDelay = Math.random() < 0.15 ? 350 + Math.random() * 400 : 0; // 15% 概率出现长停顿（思考）
    const fast = Math.random() < 0.1 ? -30 : 0;       // 10% 概率连续快速

    try {
      await wc.sendInputEvent({ type: 'keyDown', key: ch, keyCode: ch });
      await wc.sendInputEvent({ type: 'char', char: ch });
      await wc.sendInputEvent({ type: 'keyUp', key: ch, keyCode: ch });
    } catch (_) {}

    // 5. 5% 概率模拟错字 + 退格修正
    if (i > 0 && Math.random() < 0.05) {
      const wrongChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
      try {
        await wc.sendInputEvent({ type: 'keyDown', key: wrongChar, keyCode: wrongChar });
        await wc.sendInputEvent({ type: 'char', char: wrongChar });
        await wc.sendInputEvent({ type: 'keyUp', key: wrongChar, keyCode: wrongChar });
      } catch (_) {}
      await sleep(120 + Math.random() * 200);
      try {
        await wc.sendInputEvent({ type: 'keyDown', key: 'Backspace', keyCode: 'Backspace' });
        await wc.sendInputEvent({ type: 'keyUp', key: 'Backspace', keyCode: 'Backspace' });
      } catch (_) {}
      await sleep(80 + Math.random() * 100);
    }

    await sleep(Math.max(30, baseDelay + burstDelay + fast));
  }

  return { success: true, length: text.length };
}

/**
 * 真人滚动 - 变速 + 自然停顿
 */
async function safeScroll(view, direction, distance) {
  const wc = view.webContents;
  distance = distance || 500;
  const totalSteps = Math.ceil(distance / 80);
  let scrolled = 0;

  for (let i = 0; i < totalSteps; i++) {
    const remaining = distance - scrolled;
    const step = Math.min(80, remaining);
    const deltaY = direction === 'up' ? -step : step;

    try {
      await wc.sendInputEvent({
        type: 'mouseWheel',
        x: 400 + Math.floor(Math.random() * 200),
        y: 300 + Math.floor(Math.random() * 100),
        deltaX: 0,
        deltaY
      });
    } catch (_) {}

    scrolled += step;
    // 变速：开头慢、中间快、结尾慢
    const t = i / totalSteps;
    const speed = 0.4 + Math.sin(t * Math.PI) * 0.6;
    await sleep(60 + Math.floor(speed * 180));
  }

  return { success: true, direction, distance };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 强制点击 - 绕过遮挡元素（参考 Playwright force: true）
 * 实现策略：
 *   1. 三态检测可点击性（信息性，不强制）
 *   2. 遮挡元素 → ESC 关闭（用原生 keyEvent，isTrusted=true）
 *   3. 必须用 CDP sendInputEvent 真实鼠标 - 不用 element.click()（isTrusted=false）
 *   4. 真人试探性微移 + Bezier 轨迹 + 悬停 + 点击
 *
 * @param {object} view - Electron BrowserView
 * @param {object} query - {dataE2E, selector, text, textMode, x, y}
 * @param {object} options - {timeout, force: bool, delay: ms}
 * @returns {Promise<{success, error?, x?, y?, info?}>}
 */
async function forceClick(view, query, options) {
  options = options || {};
  const wc = view.webContents;
  const timeout = options.timeout || 3000;
  const force = options.force !== false;
  const t0 = Date.now();

  // 1. 等待元素出现（不限可点击）- 随机化轮询间隔避免被反爬检测
  let state = null;
  while (Date.now() - t0 < timeout) {
    state = await wc.executeJavaScript(`(${TRIPLE_CHECK_SCRIPT})(${JSON.stringify(query)})`);
    if (state && state.state !== 'absent') break;
    // 随机抖动 80-180ms，避免固定轮询特征
    await sleep(80 + Math.floor(Math.random() * 100));
  }
  if (!state || state.state === 'absent') {
    return { success: false, error: 'element_not_found', state };
  }

  if (!force && state.state !== 'clickable') {
    return { success: false, error: 'not_clickable', state };
  }

  // 2. 解析 query 到精确 selector（不污染 window 全局）
  const selResolver = `(() => {
    const escape = (typeof CSS !== 'undefined' && CSS.escape)
      ? CSS.escape.bind(CSS)
      : function(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g, function(c){ return '\\\\' + c; }); };
    const q = ${JSON.stringify(query)};
    if (q.selector) return { ok: true, selector: q.selector, index: 0 };
    if (q.dataE2E) return { ok: true, selector: '[data-e2e="' + q.dataE2E + '"]', index: 0 };
    if (q.text) {
      const all = document.querySelectorAll('*');
      let idx = 0;
      for (const el of all) {
        const t = (el.innerText || el.textContent || '').trim();
        const mode = q.textMode || 'includes';
        const match = mode === 'exact' ? t === q.text
          : mode === 'startsWith' ? t.startsWith(q.text)
          : t.includes(q.text);
        if (!match) continue;
        if (el.children.length > 5) continue;
        if (idx === (q.index || 0)) {
          // 重新计算精确 selector
          let sel = '';
          if (el.id) sel = '#' + escape(el.id);
          else if (el.getAttribute('data-e2e')) sel = '[data-e2e="' + el.getAttribute('data-e2e') + '"]';
          else {
            const path = [];
            let cur = el;
            while (cur && cur !== document.body && path.length < 6) {
              let part = cur.tagName.toLowerCase();
              if (cur.className && typeof cur.className === 'string') {
                const cls = cur.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
                if (cls.length) part += '.' + cls.map(c => escape(c)).join('.');
              }
              const parent = cur.parentElement;
              if (parent) {
                const sibs = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
                if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
              }
              path.unshift(part);
              cur = cur.parentElement;
            }
            sel = path.join(' > ');
          }
          return { ok: true, selector: sel, index: 0, text: t.substring(0, 30) };
        }
        idx++;
      }
      return { ok: false, error: 'text_not_found', text: q.text };
    }
    return { ok: false, error: 'no_query' };
  })()`;

  const resolved = await wc.executeJavaScript(selResolver);
  if (!resolved || !resolved.ok) {
    return { success: false, error: resolved && resolved.error || 'resolve_failed', state };
  }

  // 3. 等待目标元素动画完成（关键：避免在 transform/opacity 变化过程中点击）
  await waitForAnimationEnd(wc, resolved.selector, 1500).catch(() => null);

  // 4. 元素矩形
  const rect = await wc.executeJavaScript(`(function(sel){
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  })(${JSON.stringify(resolved.selector)})`);
  if (!rect || rect.w <= 0 || rect.h <= 0) {
    return { success: false, error: 'no_rect', state };
  }
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);

  // 5. 遮挡检测与预处理（避免被反爬检测：用真人 ESC 而非 JS 操作）
  const overlay = await checkOverlayAt(view, cx, cy);
  if (overlay.overlay && overlay.dismissable) {
    // 通过原生键盘事件发送 ESC（与真人操作一致，可 isTrusted）
    try { await wc.sendInputEvent({ type: 'keyDown', key: 'Escape', keyCode: 'Escape' }); } catch (_) {}
    try { await wc.sendInputEvent({ type: 'keyUp', key: 'Escape', keyCode: 'Escape' }); } catch (_) {}
    await sleep(200 + Math.floor(Math.random() * 200));
  }

  // 6. 真人点击（必须用 CDP sendInputEvent 才会 isTrusted=true）
  //    不用 element.click()，不用 dispatchEvent 模拟 - 这两种 isTrusted=false
  //    都可被反爬检测识别
  const human = require('./humanBehavior');

  // 6.1 先做几次"试探性微移"（真人会先在附近小幅移动再定位）
  const approachPoints = [
    { x: cx + (Math.random() - 0.5) * 12, y: cy + (Math.random() - 0.5) * 12 },
    { x: cx + (Math.random() - 0.5) * 6, y: cy + (Math.random() - 0.5) * 6 }
  ];
  for (const p of approachPoints) {
    try { await wc.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) }); } catch (_) {}
    await sleep(40 + Math.floor(Math.random() * 80));
  }

  // 6.2 真实鼠标轨迹 + 悬停 + 点击
  try {
    await human.humanClick(wc, cx, cy);
  } catch (e) {
    logger.warn('forceClick humanClick failed: ' + e.message);
  }

  await sleep(options.delay || 250 + Math.floor(Math.random() * 200));
  return {
    success: true,
    x: cx, y: cy,
    strategy: 'force_natural',
    state
  };
}

/**
 * 检测坐标点处的遮挡元素（overlay/modal/backdrop/mask/popup）
 */
async function checkOverlayAt(view, x, y) {
  try {
    const wc = view.webContents;
    const r = await wc.executeJavaScript(`(function(){
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return { overlay: false, top: null };
      const tag = el.tagName.toLowerCase();
      const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const ariaModal = (el.getAttribute('aria-modal') || '').toLowerCase();

      const overlayTokens = ['modal', 'backdrop', 'overlay', 'mask', 'popup', 'dialog', 'drawer', 'curtain', 'scrim'];
      const isOverlay = overlayTokens.some(t => cls.includes(t)) || role === 'dialog' || ariaModal === 'true';

      return {
        overlay: isOverlay,
        top: tag,
        cls: cls.substring(0, 80),
        role,
        ariaModal,
        zIndex: getComputedStyle(el).zIndex,
        dismissable: isOverlay && !cls.includes('required') && !cls.includes('forced')
      };
    })()`);
    return r || { overlay: false };
  } catch (e) {
    return { overlay: false, error: e.message };
  }
}

/**
 * 等待元素动画完成（兼容 Web Animations API + CSS transitions + 动画 class）
 * 设计要点：
 *   - 优先使用 element.getAnimations()（覆盖 WAAPI）
 *   - 回退到一次性监听 transitionend / animationend 事件
 *   - 检测常见动画类名（fade/slide/collapse 抖动）
 *   - 含超时保护，避免永久挂起
 *
 * @param {object} wc - webContents
 * @param {string} selector
 * @param {number} timeout - 毫秒
 * @returns {Promise<{completed: bool, reason?: string, count?: number}>}
 */
async function waitForAnimationEnd(wc, selector, timeout) {
  timeout = timeout || 2000;
  const script = `(function(sel, t){
    return new Promise(resolve => {
      const el = document.querySelector(sel);
      if (!el) { resolve({ completed: false, reason: 'not_found' }); return; }

      // 1. Web Animations API
      const anims = (typeof el.getAnimations === 'function') ? el.getAnimations() : [];
      const cssAnims = (typeof el.getAnimations === 'function') ? el.getAnimations({ subtree: true }) : [];

      if (anims.length > 0) {
        let done = 0;
        const total = anims.length;
        const finish = () => { done++; if (done >= total) resolve({ completed: true, count: total, source: 'waapi' }); };
        anims.forEach(a => {
          if (a.playState === 'finished') finish();
          else a.finished.then(finish).catch(finish);
        });
      } else {
        // 2. CSS animation/transition 一次性事件
        let fired = 0;
        let expected = 0;
        const cs = getComputedStyle(el);
        if (cs.animationName && cs.animationName !== 'none') expected++;
        if (cs.transitionProperty && cs.transitionProperty !== 'none' && cs.transitionDuration !== '0s') expected++;

        if (expected === 0) { resolve({ completed: true, count: 0, source: 'none' }); return; }

        const onEnd = (e) => {
          if (e.target !== el) return;
          fired++;
          if (fired >= expected) {
            el.removeEventListener('animationend', onEnd);
            el.removeEventListener('transitionend', onEnd);
            resolve({ completed: true, count: expected, source: 'css_event' });
          }
        };
        el.addEventListener('animationend', onEnd, { once: true });
        el.addEventListener('transitionend', onEnd, { once: true });
        // 已有 completed 状态时直接放过
        if (cs.animationPlayState === 'running' || cs.transitionDuration === '0s') {
          // 仍等待
        }
      }

      // 3. 兜底超时
      setTimeout(() => resolve({ completed: true, reason: 'timeout_protection', source: 'fallback' }), t);
    });
  })(${JSON.stringify(selector)}, ${timeout})`;
  try {
    const r = await wc.executeJavaScript(script);
    return r || { completed: true, reason: 'no_result' };
  } catch (e) {
    return { completed: true, reason: 'js_error:' + e.message };
  }
}

/**
 * 模拟拖放 - 通过原生 mousedown/mousemove/mouseup 实现（isTrusted=true）
 * 实现要点：
 *   - 不用 DragEvent（DragEvent.isTrusted 永远为 false，会被反爬识别）
 *   - 改用 CDP sendInputEvent 真实鼠标序列
 *   - 中间轨迹按 Bezier 曲线 + 真实步进
 *   - 间隔抖动 8-25ms 模拟真人
 *
 * @param {object} view
 * @param {string} fromSelector - 拖动源
 * @param {string} toSelector   - 目标容器
 * @param {object} options      - {steps, holdTime, delay}
 * @returns {Promise<{success, error?, from?, to?}>}
 */
async function html5DragDrop(view, fromSelector, toSelector, options) {
  options = options || {};
  const wc = view.webContents;
  const human = require('./humanBehavior');

  // 1. 计算源/目标坐标
  const coords = await wc.executeJavaScript(`(function(from, to){
    const src = document.querySelector(from);
    const dst = document.querySelector(to);
    if (!src) return { ok: false, error: 'source_not_found', from };
    if (!dst) return { ok: false, error: 'target_not_found', to };
    const sr = src.getBoundingClientRect();
    const tr = dst.getBoundingClientRect();
    return {
      ok: true,
      from: { x: Math.round(sr.x + sr.width / 2), y: Math.round(sr.y + sr.height / 2),
              w: Math.round(sr.width), h: Math.round(sr.height) },
      to: { x: Math.round(tr.x + tr.width / 2), y: Math.round(tr.y + tr.height / 2),
            w: Math.round(tr.width), h: Math.round(tr.height) }
    };
  })(${JSON.stringify(fromSelector)}, ${JSON.stringify(toSelector)})`);

  if (!coords || !coords.ok) {
    return { success: false, error: (coords && coords.error) || 'resolve_failed' };
  }

  const sx = coords.from.x, sy = coords.from.y;
  const tx = coords.to.x, ty = coords.to.y;
  const dist = Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2);
  const steps = Math.max(10, Math.min(60, options.steps || Math.floor(dist / 20) + 12));

  // 2. 用 Bezier 路径生成中间点（自然拖拽轨迹）
  const path = human.bezierPath(sx, sy, tx, ty);
  // 截取 steps 个中间帧
  const sampledPath = [];
  for (let i = 0; i <= steps; i++) {
    const idx = Math.floor(i * (path.length - 1) / steps);
    sampledPath.push(path[idx]);
  }

  // 3. mousedown 在源上
  await human.mouseMove(wc, sx, sy);
  await sleep(60 + Math.floor(Math.random() * 80));
  try { await wc.sendInputEvent({ type: 'mouseDown', x: sx, y: sy, button: 'left', clickCount: 1 }); } catch (_) {}
  await sleep(options.holdTime || (100 + Math.floor(Math.random() * 100)));

  // 4. 沿轨迹 mousemove（带自然停顿 - 真人拖动会有微小停顿）
  for (let i = 1; i < sampledPath.length; i++) {
    const p = sampledPath[i];
    try { await wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }); } catch (_) {}
    // 真人拖动节奏：8-25ms
    await sleep(8 + Math.floor(Math.random() * 17));
    // 偶尔插入 50-100ms 停顿（5% 概率），模拟手指重新定位
    if (Math.random() < 0.05) {
      await sleep(50 + Math.floor(Math.random() * 50));
    }
  }

  // 5. 移动到目标中心，悬停一下
  await sleep(options.hoverTime || (60 + Math.floor(Math.random() * 80)));
  try { await wc.sendInputEvent({ type: 'mouseMove', x: tx, y: ty }); } catch (_) {}
  await sleep(40 + Math.floor(Math.random() * 60));

  // 6. mouseup 释放
  try { await wc.sendInputEvent({ type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 }); } catch (_) {}
  await sleep(options.delay || 150 + Math.floor(Math.random() * 150));

  logger.info(`html5DragDrop OK ${fromSelector}(${sx},${sy}) -> ${toSelector}(${tx},${ty}) dist=${Math.round(dist)} steps=${steps}`);
  return {
    success: true,
    from: coords.from,
    to: coords.to,
    distance: Math.round(dist),
    steps
  };
}

module.exports = {
  waitForClickable,
  safeClick,
  forceClick,
  safeType,
  safeScroll,
  checkStateChanged,
  checkOverlayAt,
  waitForAnimationEnd,
  html5DragDrop,
  diagnoseNoMatch,
  DEFAULT_TIMEOUT,
  DEFAULT_RETRY
};
