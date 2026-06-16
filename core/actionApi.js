/**
 * 系统操作 API 层
 *
 * 把所有 UI 自动化能力封装为统一的操作接口，供 HTTP API 调用
 * 解决：通过 API 驱动系统，避免 DOM 文本匹配的不稳定性
 *
 * 覆盖能力：
 *   1. 基础操作 - click / hover / type / scroll / keypress / evaluate
 *   2. 查找操作 - findElement / findByText / findBySelector / dumpDOM
 *   3. 业务操作 - search / filter / openVideo / closeVideo / comment / sendDM
 *   4. 序列操作 - runSequence（批量执行）
 *   5. 诊断操作 - diagnose / screenshot / getNetworkLog
 *
 * 所有操作都返回统一格式 { ok, data?, error? }
 */

const path = require('path');
const fs = require('fs');
const { getLogger } = require('./logger');
const logger = getLogger('ActionAPI');

const human = require('./humanBehavior');
const smartOps = require('./smartOps');
const robustClick = require('./robustClick');
const dom = require('./domUtils');
const match = require('./match');

let getDouyinView = null;
let searchEngine = null;
let cdpInterceptor = null;
let getCdpInterceptor = null;  // getter 函数（CDP 创建后才可用）
let videoProcessor = null;
let notifier = null;

function bind({
  getDouyinView: gv,
  searchEngine: se,
  cdpInterceptor: cdp,
  getCdpInterceptor: gCdp,
  videoProcessor: vp,
  notifier: nt
}) {
  if (gv) getDouyinView = gv;
  if (se) searchEngine = se;
  if (cdp) cdpInterceptor = cdp;
  if (gCdp) getCdpInterceptor = gCdp;
  if (vp) videoProcessor = vp;
  if (nt) notifier = nt;
}

// ==================== 工具 ====================

function getView() {
  if (!getDouyinView) throw new Error('getDouyinView 未绑定');
  const v = getDouyinView();
  if (!v || !v.webContents) throw new Error('BrowserView 不可用');
  return v;
}

async function js(wc, script) {
  try { return await wc.executeJavaScript(script); }
  catch (e) { return { __error: e.message }; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ok(data) { return { ok: true, data }; }
function fail(error, code) { return { ok: false, error, code: code || 'ACTION_ERROR' }; }

function ensureView() {
  try { return getView(); }
  catch (e) { return null; }
}

/**
 * 懒加载 CDP 拦截器
 * 优先用 getCdpInterceptor getter（CDP 创建后才有），回退到 cdpInterceptor 引用
 */
function ensureCdp() {
  if (getCdpInterceptor) {
    try { return getCdpInterceptor(); }
    catch (e) { /* fallthrough */ }
  }
  return cdpInterceptor;
}

// ==================== 基础操作 ====================

/**
 * 通用点击 - 支持多种定位策略
 * @param {object} body - {selector|dataE2E|text|x,y, button, force, delay, hover}
 */
async function click(body) {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;

  // 1. 坐标点击
  if (body.x != null && body.y != null) {
    const human = body.human !== false;
    if (human) {
      if (body.hover) {
        await require('./humanBehavior').mouseHover(wc, body.x, body.y, 60, 30, body.delay || 800);
      } else {
        await require('./humanBehavior').humanClick(wc, body.x, body.y);
      }
    } else {
      try { await wc.sendInputEvent({ type: 'mouseMove', x: body.x, y: body.y }); } catch(_) {}
      await sleep(50);
      try { await wc.sendInputEvent({ type: 'mouseDown', x: body.x, y: body.y, button: body.button || 'left' }); } catch(_) {}
      await sleep(30);
      try { await wc.sendInputEvent({ type: 'mouseUp', x: body.x, y: body.y, button: body.button || 'left' }); } catch(_) {}
    }
    await sleep(body.delay || 200);
    return ok({ x: body.x, y: body.y, mode: 'coords' });
  }

  // 2. 文本点击（不依赖按钮 - 先 find 再 click）
  if (body.text) {
    const findRes = await findElement({ text: body.text, dataE2E: body.dataE2E, role: body.role });
    if (!findRes.ok) return findRes;
    if (!findRes.data.found) return fail('element_not_found', 'NOT_FOUND');

    const el = findRes.data;
    if (body.hover) {
      await human.mouseHover(wc, el.x, el.y, 60, 30, body.delay || 1200);
    } else {
      await human.humanClick(wc, el.x, el.y);
    }
    await sleep(body.delay || 300);
    return ok({ x: el.x, y: el.y, text: el.text, mode: 'text' });
  }

  // 3. dataE2E 点击
  if (body.dataE2E) {
    const r = await js(wc, `(() => {
      const el = document.querySelector('[data-e2e="${body.dataE2E}"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      el.scrollIntoView({ block: 'center' });
      const r2 = el.getBoundingClientRect();
      return { x: Math.round(r2.x + r2.width/2), y: Math.round(r2.y + r2.height/2), w: r2.width, h: r2.height };
    })()`);
    if (!r) return fail('dataE2E_not_found', 'NOT_FOUND');
    if (body.hover) {
      await human.mouseHover(wc, r.x, r.y, 60, 30, body.delay || 1200);
    } else {
      await human.humanClick(wc, r.x, r.y);
    }
    await sleep(body.delay || 300);
    return ok({ ...r, mode: 'dataE2E', dataE2E: body.dataE2E });
  }

  // 4. selector 点击
  if (body.selector) {
    const r = await js(wc, `(() => {
      const el = document.querySelector(${JSON.stringify(body.selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2), w: rect.width, h: rect.height };
    })()`);
    if (!r) return fail('selector_not_found', 'NOT_FOUND');
    if (body.hover) {
      await human.mouseHover(wc, r.x, r.y, 60, 30, body.delay || 1200);
    } else {
      await human.humanClick(wc, r.x, r.y);
    }
    await sleep(body.delay || 300);
    return ok({ ...r, mode: 'selector', selector: body.selector });
  }

  return fail('no_target_specified', 'BAD_REQUEST');
}

/**
 * 悬停 - 触发 hover 行为
 * @param {object} body - {x, y, duration}
 */
async function hover(body) {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;

  if (body.x != null && body.y != null) {
    await human.mouseHover(wc, body.x, body.y, 60, 30, body.duration || 1200);
    return ok({ x: body.x, y: body.y, mode: 'coords' });
  }

  // 通过文本/选择器找元素再悬停
  if (body.text || body.selector || body.dataE2E) {
    const findRes = await findElement(body);
    if (!findRes.ok || !findRes.data.found) return fail('element_not_found', 'NOT_FOUND');
    const el = findRes.data;
    await human.mouseHover(wc, el.x, el.y, 60, 30, body.duration || 1200);
    return ok({ x: el.x, y: el.y, text: el.text, tag: el.tag, mode: el.source || 'find' });
  }

  return fail('no_target_specified', 'BAD_REQUEST');
}

/**
 * 输入文本
 * @param {object} body - {text, selector, append, clear, pressEnter}
 */
async function type(body) {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;

  if (!body.text && body.text !== '') return fail('text_required', 'BAD_REQUEST');

  // 定位输入框
  let target = null;
  if (body.selector) {
    target = body.selector;
  } else {
    // 找当前活动元素或搜索框
    const r = await js(wc, `(() => {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
        return { active: true, selector: ae.tagName.toLowerCase() + (ae.type ? '[type="' + ae.type + '"]' : '') };
      }
      // 找搜索框
      const searchInput = document.querySelector('input[type="search"]') || document.querySelector('input[placeholder*="搜索" i]') || document.querySelector('input[placeholder*="search" i]');
      if (searchInput) {
        const rect = searchInput.getBoundingClientRect();
        return { active: false, x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2), tag: 'search' };
      }
      return null;
    })()`);
    if (!r) return fail('no_input_target', 'NOT_FOUND');
    if (r.x != null) {
      // 点击搜索框
      await human.humanClick(wc, r.x, r.y);
      await sleep(300);
    } else if (r.selector) {
      // 已经在活动元素上
    }
  }

  // 清空
  if (body.clear) {
    await human.keyPress(wc, 'Control+a');
    await sleep(50);
    await human.keyPress(wc, 'Delete');
    await sleep(100);
  }

  // 输入 - 中文/非ASCII用 insertText，ASCII用逐字 sendInputEvent
  const text = String(body.text);
  const hasNonAscii = /[^\x00-\x7F]/.test(text);

  if (hasNonAscii || body.useInsertText) {
    // 中文等非ASCII字符必须用 insertText（sendInputEvent char 不支持）
    try { await wc.insertText(text); } catch (e) { return fail(e.message); }
  } else {
    // ASCII 逐字输入（真人节奏）
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      try { await wc.sendInputEvent({ type: 'char', key: ch }); } catch (_) {}
      await sleep(30 + Math.floor(Math.random() * 60));
    }
  }

  // 回车
  if (body.pressEnter || body.enter) {
    await sleep(200);
    await wc.sendInputEvent({ type: 'keyDown', key: 'Enter', keyCode: 'Enter' });
    await wc.sendInputEvent({ type: 'keyUp', key: 'Enter', keyCode: 'Enter' });
  }

  return ok({ text, length: text.length });
}

/**
 * 滚动
 * @param {object} body - {direction, distance, x, y}
 */
async function scroll(body) {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;

  // 1. 定向滚动：滚动指定选择器内的元素
  if (body.selector) {
    const r = await js(wc, `(() => {
      const el = document.querySelector(${JSON.stringify(body.selector)});
      if (!el) return null;
      // 找滚动容器（自身或父元素 overflow: scroll/auto）
      let target = el;
      const dir = ${body.direction === 'up' ? -1 : 1};
      const dist = ${body.distance || 3};
      while (target) {
        const s = getComputedStyle(target);
        if (s.overflowY === 'auto' || s.overflowY === 'scroll') {
          target.scrollBy(0, dir * dist * 100);
          return { scrolled: true, scrollTop: target.scrollTop, scrollHeight: target.scrollHeight };
        }
        target = target.parentElement;
      }
      // 降级：直接 scrollIntoView
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return { scrolled: true, mode: 'scrollIntoView' };
    })()`);
    if (!r) return fail('selector_not_found', 'NOT_FOUND');
    return ok({ mode: 'selector', ...r });
  }

  // 2. 页面滚动（鼠标滚轮）
  const dir = body.direction || 'down';
  const dist = body.distance || 3;
  const x = body.x || 500;
  const y = body.y || 400;
  try {
    await wc.sendInputEvent({
      type: 'mouseWheel',
      x, y,
      deltaX: 0,
      deltaY: (dir === 'down' ? 1 : -1) * dist * 100
    });
  } catch (e) { return fail(e.message); }
  return ok({ direction: dir, distance: dist, mode: 'wheel' });
}

/**
 * 键盘按键
 * @param {object} body - {key, modifiers: ['control', 'shift'...]}
 */
async function keypress(body) {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;
  const key = body.key || body.keyCode;
  if (!key) return fail('key_required', 'BAD_REQUEST');

  try {
    const mods = body.modifiers || [];
    if (mods.length) {
      for (const m of mods) {
        await wc.sendInputEvent({ type: 'keyDown', key: m, modifiers: [] });
      }
    }
    await wc.sendInputEvent({ type: 'keyDown', key, keyCode: key, modifiers: mods });
    await sleep(50);
    await wc.sendInputEvent({ type: 'keyUp', key, keyCode: key, modifiers: mods });
    if (mods.length) {
      for (const m of mods.reverse()) {
        await wc.sendInputEvent({ type: 'keyUp', key: m, modifiers: [] });
      }
    }
  } catch (e) { return fail(e.message); }
  return ok({ key, modifiers: body.modifiers || [] });
}

/**
 * 在页面里执行 JS（不污染全局）
 * @param {object} body - {script, async: bool}
 */
async function evaluate(body) {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;
  if (!body.script) return fail('script_required', 'BAD_REQUEST');
  try {
    if (body.async) {
      const id = '__async_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
      const wrapped = `(async function(){ try { window['${id}'] = await (function(){ ${body.script} })(); return window['${id}']; } catch(e) { return { __error: e.message, stack: e.stack }; } })()`;
      const r = await wc.executeJavaScript(wrapped);
      return ok(r);
    }
    const r = await wc.executeJavaScript(body.script);
    return ok(r);
  } catch (e) { return fail(e.message); }
}

// ==================== 查找操作 ====================

/**
 * 查找元素 - 多策略
 * @param {object} body - {text, dataE2E, selector, role, x, y, w, h, includeInvisible, all}
 */
async function findElement(body) {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;
  const includeInvisible = body.includeInvisible === true;
  const findAll = body.all === true;

  const script = `(function(){
    const opts = ${JSON.stringify(body)};
    const includeInvisible = ${includeInvisible};
    const findAll = ${findAll};
    const results = [];

    const isVisible = (el) => {
      if (includeInvisible) return true;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
      return r.x < window.innerWidth && r.x + r.width > 0 && r.y < window.innerHeight && r.y + r.height > 0;
    };

    // 1. selector
    if (opts.selector) {
      const els = document.querySelectorAll(opts.selector);
      for (const el of els) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        results.push({
          source: 'selector',
          selector: opts.selector,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.textContent || '').trim().substring(0, 100),
          x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
          w: Math.round(r.width), h: Math.round(r.height),
          className: typeof el.className === 'string' ? el.className.substring(0, 80) : '',
          dataE2E: el.getAttribute('data-e2e') || ''
        });
        if (!findAll) break;
      }
    }

    // 2. dataE2E
    if (results.length === 0 && opts.dataE2E) {
      const els = document.querySelectorAll('[data-e2e="' + opts.dataE2E + '"]');
      for (const el of els) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        results.push({
          source: 'dataE2E',
          dataE2E: opts.dataE2E,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.textContent || '').trim().substring(0, 100),
          x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
          w: Math.round(r.width), h: Math.round(r.height)
        });
        if (!findAll) break;
      }
    }

    // 3. text
    if (results.length === 0 && opts.text) {
      const all = document.querySelectorAll('*');
      const candidates = [];
      for (const el of all) {
        const t = (el.innerText || el.textContent || '').trim();
        const mode = opts.textMode || 'includes';
        const match = mode === 'exact' ? t === opts.text
          : mode === 'startsWith' ? t.startsWith(opts.text)
          : t.includes(opts.text);
        if (!match) continue;
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        // 精确匹配优先，面积越小越精确
        const isExact = t === opts.text;
        candidates.push({
          source: 'text',
          text: t.substring(0, 100),
          mode: isExact ? 'exact' : mode,
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === 'string' ? el.className.substring(0, 80) : '',
          x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
          w: Math.round(r.width), h: Math.round(r.height),
          area,
          isExact,
          dataE2E: el.getAttribute('data-e2e') || ''
        });
      }
      // 排序：精确匹配优先，面积从小到大（最小 = 最精确的按钮）
      candidates.sort((a, b) => {
        if (a.isExact !== b.isExact) return a.isExact ? -1 : 1;
        return a.area - b.area;
      });
      if (findAll) {
        results.push(...candidates);
      } else if (candidates.length > 0) {
        results.push(candidates[0]);
      }
    }

    // 4. role
    if (results.length === 0 && opts.role) {
      const els = document.querySelectorAll('[role="' + opts.role + '"]');
      for (const el of els) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        results.push({
          source: 'role',
          role: opts.role,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.textContent || '').trim().substring(0, 100),
          x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
          w: Math.round(r.width), h: Math.round(r.height)
        });
        if (!findAll) break;
      }
    }

    return findAll ? results : (results[0] || null);
  })()`;

  try {
    const r = await wc.executeJavaScript(script);
    if (findAll) {
      return ok({ found: r.length > 0, items: r, count: r.length });
    }
    if (!r) return ok({ found: false });
    return ok({ found: true, ...r });
  } catch (e) {
    return fail(e.message);
  }
}

/**
 * 转储 DOM 树（带属性 + 文本）
 * @param {object} body - {selector, maxDepth, maxNodes}
 */
async function dumpDOM(body) {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;
  const maxDepth = body.maxDepth || 8;
  const maxNodes = body.maxNodes || 500;

  const script = `(function(opts){
    const maxDepth = ${maxDepth};
    const maxNodes = ${maxNodes};
    let count = 0;
    const out = [];

    const visit = (el, depth) => {
      if (count >= maxNodes) return;
      if (depth > maxDepth) return;
      if (!el || el.nodeType !== 1) return;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      const text = (el.innerText || el.textContent || '').trim().substring(0, 100);
      const attrs = {};
      for (const a of el.attributes) {
        if (/^(class|id|data-|aria-|role|href|type|name|placeholder|title|alt)/.test(a.name)) {
          attrs[a.name] = a.value.substring(0, 100);
        }
      }
      out.push({
        depth,
        tag: el.tagName.toLowerCase(),
        visible,
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        text: text,
        className: typeof el.className === 'string' ? el.className.substring(0, 100) : '',
        attrs,
        childCount: el.children.length
      });
      count++;
      for (const c of el.children) visit(c, depth + 1);
    };

    const root = opts.selector ? document.querySelector(opts.selector) : document.body;
    if (!root) return { error: 'root_not_found', selector: opts.selector };
    visit(root, 0);
    return { totalNodes: count, nodes: out };
  })(${JSON.stringify(body || {})})`;

  try {
    const r = await wc.executeJavaScript(script);
    return ok(r);
  } catch (e) { return fail(e.message); }
}

/**
 * 在指定文本附近找坐标（点击位置可在文本内自定义偏移）
 */
async function getElementCenter(body) {
  const r = await findElement(body);
  if (!r.ok) return r;
  if (!r.data.found) return fail('not_found', 'NOT_FOUND');
  return ok({ x: r.data.x, y: r.data.y });
}

// ==================== 业务操作 ====================

/**
 * 浏览器导航
 */
async function navigate(body) {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;
  if (!body.url) return fail('url_required', 'BAD_REQUEST');
  try {
    await wc.loadURL(body.url);
    return ok({ url: body.url });
  } catch (e) { return fail(e.message); }
}

async function goBack() {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;
  try {
    if (wc.canGoBack()) {
      wc.goBack();
      return ok({ back: true });
    }
    return ok({ back: false, reason: 'no_history' });
  } catch (e) { return fail(e.message); }
}

/**
 * 启动搜索
 */
async function startSearch(body) {
  if (!searchEngine) return fail('searchEngine_not_bound', 'NOT_READY');
  try {
    if (!searchEngine.isRunning()) {
      searchEngine.startSearch(body.params || body, () => {}, () => {}, () => {});
      return ok({ started: true, params: body.params || body });
    }
    return fail('search_already_running', 'BUSY');
  } catch (e) { return fail(e.message); }
}

async function stopSearch() {
  if (!searchEngine) return fail('searchEngine_not_bound', 'NOT_READY');
  try {
    searchEngine.stopSearch();
    return ok({ stopped: true });
  } catch (e) { return fail(e.message); }
}

async function pauseSearch() {
  if (!searchEngine) return fail('searchEngine_not_bound', 'NOT_READY');
  try {
    searchEngine.pauseSearch();
    return ok({ paused: searchEngine.isPaused() });
  } catch (e) { return fail(e.message); }
}

// ==================== 网络抓包 ====================

/**
 * 获取网络抓包数据
 * @param {object} body - {url, method, from, to, maxBytes, body: bool, full: bool}
 */
async function getNetworkLog(body) {
  const cdp = ensureCdp();
  body = body || {};
  if (!cdp) return fail('cdp_not_bound', 'NOT_READY');

  // 取数据
  let log = cdp.getAllRequests ? cdp.getAllRequests() : [];

  // 过滤
  if (body.urlContains) {
    const k = String(body.urlContains).toLowerCase();
    log = log.filter(r => (r.url || '').toLowerCase().includes(k));
  }
  if (body.method) {
    log = log.filter(r => r.method === body.method);
  }
  if (body.from) {
    const t = body.from;
    log = log.filter(r => r.ts >= t);
  }
  if (body.to) {
    const t = body.to;
    log = log.filter(r => r.ts <= t);
  }
  if (body.hasResponse === true) log = log.filter(r => r.response);
  if (body.hasResponse === false) log = log.filter(r => !r.response);
  if (body.maxBytes) {
    const mb = body.maxBytes;
    log = log.filter(r => !r.response || (r.response.body && r.response.body.length <= mb));
  }

  // 摘要（去掉 body）避免响应过大
  if (!body.full) {
    log = log.map(r => ({
      ts: r.ts,
      method: r.method,
      url: r.url,
      status: r.response ? r.response.status : null,
      responseType: r.response ? r.response.type : null,
      bodySize: r.response && r.response.body ? r.response.body.length : 0,
      commentCount: r.parsed ? r.parsed.commentCount : null
    }));
  }

  return ok({ count: log.length, log, last: cdp.getLastSummary ? cdp.getLastSummary() : null });
}

/**
 * 搜索网络请求
 */
async function searchNetworkLog(body) {
  const cdp = ensureCdp();
  if (!cdp) return fail('cdp_not_bound', 'NOT_READY');
  const k = String(body.keyword || '').toLowerCase();
  if (!k) return ok({ count: 0, log: [] });
  let log = cdp.getAllRequests ? cdp.getAllRequests() : [];
  log = log.filter(r => {
    if ((r.url || '').toLowerCase().includes(k)) return true;
    if (r.response && r.response.body && r.response.body.toLowerCase().includes(k)) return true;
    return false;
  });
  if (!body.full) {
    log = log.slice(0, 200);
  }
  return ok({ count: log.length, log });
}

/**
 * 清空网络日志
 */
async function clearNetworkLog() {
  const cdp = ensureCdp();
  if (!cdp) return fail('cdp_not_bound', 'NOT_READY');
  if (cdp.clearRequests) cdp.clearRequests();
  return ok({ cleared: true });
}

/**
 * 获取视频评论（通过 CDP）
 */
async function getComments(body) {
  const cdp = ensureCdp();
  if (!cdp) return fail('cdp_not_bound', 'NOT_READY');
  const aid = body.aid || body.awemeId;
  if (!aid) return ok({ comments: [] });
  const comments = cdp.getComments ? cdp.getComments(aid) : [];
  return ok({ aid, count: comments.length, comments });
}

// ==================== 序列执行 ====================

/**
 * 批量执行多个操作
 * @param {object} body - {steps: [{action, params, stopOnError, timeout}], delay}
 */
async function runSequence(body) {
  if (!Array.isArray(body.steps)) return fail('steps_required', 'BAD_REQUEST');
  const results = [];
  for (let i = 0; i < body.steps.length; i++) {
    const step = body.steps[i];
    const action = step.action;
    const params = step.params || {};
    const stopOnError = step.stopOnError !== false;
    const timeout = step.timeout || 30000;
    try {
      const fn = ACTIONS[action];
      if (!fn) {
        results.push({ index: i, action, ok: false, error: 'unknown_action' });
        if (stopOnError) break;
        continue;
      }
      const r = await Promise.race([
        fn(params),
        new Promise(res => setTimeout(() => res({ ok: false, error: 'timeout' }), timeout))
      ]);
      results.push({ index: i, action, ...r });
      if (!r.ok && stopOnError) break;
    } catch (e) {
      results.push({ index: i, action, ok: false, error: e.message });
      if (stopOnError) break;
    }
    if (step.delay) await sleep(step.delay);
    else if (body.delay) await sleep(body.delay);
  }
  return ok({ count: results.length, results });
}

// ==================== 诊断 ====================

/**
 * 完整诊断 - 输出当前页面关键信息
 * 【改动】优先使用 webContents 同步属性，executeJavaScript 加 5s 兜底
 */
async function diagnose() {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;
  // 1) 同步部分 - 立即返回
  const sync = {
    url: '',
    isLoading: false,
    isCrashed: false,
    isDestroyed: false,
    domReady: false,
    title: ''
  };
  try {
    sync.url = wc.getURL();
    sync.isLoading = wc.isLoading();
    sync.isCrashed = wc.isCrashed && wc.isCrashed();
    sync.isDestroyed = wc.isDestroyed && wc.isDestroyed();
  } catch (e) {
    sync.error = e.message;
  }
  // 2) 异步部分 - executeJavaScript 加超时兜底
  let asyncInfo = null;
  if (!sync.isDestroyed && !sync.isCrashed) {
    try {
      const script = `(() => ({
        title: document.title,
        bodyText: (document.body && document.body.innerText) ? document.body.innerText.substring(0, 500) : '',
        hasModal: !!document.querySelector('[class*="modal" i], [role="dialog"]'),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        scroll: { x: window.scrollX, y: window.scrollY },
        readyState: document.readyState,
        domNodes: document.querySelectorAll('*').length
      }))()`;
      const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate_timeout')), 5000));
      asyncInfo = await Promise.race([wc.executeJavaScript(script), timeoutP]);
    } catch (e) {
      asyncInfo = { __error: e.message, __note: 'executeJavaScript 5s 超时或失败，页面可能正在加载' };
    }
  }
  return ok({ sync, page: asyncInfo });
}

/**
 * 截图 - 编码为 base64 PNG
 */
async function screenshot(body) {
  const v = ensureView();
  if (!v) return fail('view_unavailable');
  const wc = v.webContents;
  try {
    const img = await wc.capturePage();
    const buf = img.toPNG();
    return ok({ size: buf.length, base64: buf.toString('base64') });
  } catch (e) { return fail(e.message); }
}

// ==================== 动作注册表 ====================

const ACTIONS = {
  click, hover, type, scroll, keypress, evaluate,
  find: findElement, findElement, dumpDOM, getCenter: getElementCenter,
  navigate, back: goBack,
  startSearch, stopSearch, pauseSearch,
  networkLog: getNetworkLog, searchNetwork: searchNetworkLog, clearNetwork: clearNetworkLog,
  getComments,
  diagnose, screenshot,
  run: runSequence
};

function getActionsList() {
  return Object.keys(ACTIONS).map(name => ({
    name,
    description: ACTION_DESCRIPTIONS[name] || ''
  }));
}

const ACTION_DESCRIPTIONS = {
  click: '点击元素 - params: {selector|dataE2E|text|x,y, hover, force, delay}',
  hover: '悬停 - params: {x,y|text|selector, duration}',
  type: '输入文本 - params: {text, selector?, clear?, pressEnter?}',
  scroll: '滚动 - params: {direction, distance, x, y}',
  keypress: '按键 - params: {key, modifiers?}',
  evaluate: '执行JS - params: {script, async?}',
  find: '查找元素 - params: {selector|dataE2E|text|role, all?, includeInvisible?}',
  findElement: '查找元素（同 find）',
  dumpDOM: '转储DOM树 - params: {selector?, maxDepth?, maxNodes?}',
  getCenter: '获取元素中心坐标',
  navigate: '导航到URL - params: {url}',
  back: '浏览器后退',
  startSearch: '启动搜索 - params: 搜索参数对象',
  stopSearch: '停止搜索',
  pauseSearch: '暂停/继续搜索',
  networkLog: '获取网络抓包 - params: {urlContains, method, from, to, full?, maxBytes?}',
  searchNetwork: '搜索网络请求 - params: {keyword, full?}',
  clearNetwork: '清空网络日志',
  getComments: '获取视频评论 - params: {aid}',
  diagnose: '页面诊断 - 输出 url/title/modal/viewport 等',
  screenshot: '截图 - 返回 base64',
  run: '批量执行 - params: {steps: [{action, params, stopOnError?, timeout?}], delay?}'
};

module.exports = {
  bind,
  ACTIONS,
  getActionsList,
  ACTION_DESCRIPTIONS,
  ensureCdp,
  // 单个动作（用于 IPC）
  click, hover, type, scroll, keypress, evaluate,
  findElement, dumpDOM,
  navigate, goBack,
  startSearch, stopSearch, pauseSearch,
  getNetworkLog, searchNetworkLog, clearNetworkLog, getComments,
  runSequence, diagnose, screenshot
};
