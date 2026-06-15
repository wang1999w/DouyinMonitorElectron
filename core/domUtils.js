/**
 * DOM 操作工具（重构版 - 基于 laizan 项目学习）
 *
 * 核心改进：
 *   1. 使用 data-e2e 属性定位（抖音官方提供的测试属性，更稳定）
 *   2. waitForSelector 替代固定 sleep（事件驱动，不浪费时间）
 *   3. 多选择器降级策略（页面结构变化时自动适应）
 *   4. 键盘导航替代鼠标点击（更稳定可靠）
 *
 * 关键选择器（来自 laizan 项目）：
 *   - 评论区：#videoSideCard（检查 clientWidth > 0）
 *   - 当前视频：[data-e2e="feed-active-video"]
 *   - 评论按钮：[data-e2e="feed-comment-icon"]
 *   - 评论输入框：.comment-input-inner-container
 *   - 验证码：.second-verify-panel
 *   - 视频加载：.recommend-fake-video-img
 */

const human = require('./humanBehavior');
const { getLogger } = require('./logger');

const logger = getLogger('DomUtils');

// ========== 通用工具 ==========

async function execJS(wc, script) {
  try {
    return await wc.executeJavaScript(script);
  } catch (e) {
    return null;
  }
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 等待元素出现（替代固定 sleep）
 * @param {WebContents} wc
 * @param {string} selector - CSS 选择器
 * @param {number} timeout - 超时毫秒
 * @returns {Promise<boolean>}
 */
async function waitForElement(wc, selector, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await execJS(wc, `!!document.querySelector('${selector}')`);
    if (found) return true;
    await sleep(300, 500);
  }
  return false;
}

// ========== 搜索相关 ==========

/**
 * 查找搜索框（多策略降级）
 * 策略1: data-e2e="searchbar-input"
 * 策略2: placeholder 包含"搜索"
 * 策略3: 所有 input 中找最可能的搜索框
 */
async function findSearchInput(view) {
  const wc = view.webContents;
  return await execJS(wc, `(function(){
    // 策略1: data-e2e
    let e = document.querySelector('[data-e2e="searchbar-input"]');
    if (e) {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.x+r.width/2, y: r.y+r.height/2, w: r.width, h: r.height, val: e.value||'', strategy: 'data-e2e' };
    }
    // 策略2: placeholder
    e = document.querySelector('input[placeholder*="搜索"]');
    if (e) {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.x+r.width/2, y: r.y+r.height/2, w: r.width, h: r.height, val: e.value||'', strategy: 'placeholder' };
    }
    // 策略3: 顶部区域的 input
    for (const inp of document.querySelectorAll('input')) {
      const r = inp.getBoundingClientRect();
      if (r.y < 60 && r.width > 100 && r.height > 20 && r.x > 50) {
        return { x: r.x+r.width/2, y: r.y+r.height/2, w: r.width, h: r.height, val: inp.value||'', strategy: 'position' };
      }
    }
    return null;
  })()`);
}

/**
 * 查找搜索按钮（多策略降级）
 */
async function findSearchButton(view) {
  const wc = view.webContents;
  return await execJS(wc, `(function(){
    // 策略1: data-e2e
    let e = document.querySelector('[data-e2e="searchbar-button"]');
    if (e) {
      const r = e.getBoundingClientRect();
      if (r.width > 0) return { x: r.x+r.width/2, y: r.y+r.height/2, strategy: 'data-e2e' };
    }
    // 策略2: 文本匹配
    for (const b of document.querySelectorAll('button, div[role="button"], span')) {
      const t = (b.innerText||'').trim();
      if (t === '搜索') {
        const r = b.getBoundingClientRect();
        if (r.width > 10 && r.height > 10 && r.y < 150 && r.y > 0)
          return { x: r.x+r.width/2, y: r.y+r.height/2, strategy: 'text' };
      }
    }
    return null;
  })()`);
}

/**
 * 设置搜索框值（通过 JS 直接设置，比键盘模拟更可靠）
 */
async function setSearchInputValue(view, value) {
  const wc = view.webContents;
  // 先尝试 data-e2e 选择器
  let ok = await execJS(wc, `(function(){
    const e = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
    if (!e) return false;
    e.focus();
    e.value = '';
    // 触发 React 的合成事件
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(e, '${value.replace(/'/g, "\\'")}');
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  return ok;
}

/**
 * 验证搜索框值
 */
async function verifySearchInput(view, expectedValue) {
  const wc = view.webContents;
  const val = await execJS(wc, `document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]')?.value || ''`);
  return val.includes(expectedValue.replace('#', ''));
}

// ========== 视频相关 ==========

/**
 * 获取当前播放的视频信息
 * 使用 [data-e2e="feed-active-video"] 和 data-e2e-vid
 */
async function getCurrentVideoInfo(view) {
  return await execJS(view.webContents, `(function(){
    const el = document.querySelector('[data-e2e="feed-active-video"]');
    if (!el) return null;
    const vid = el.getAttribute('data-e2e-vid') || '';
    const r = el.getBoundingClientRect();
    return { vid, x: r.x+r.width/2, y: r.y+r.height/2, w: r.width, h: r.height };
  })()`);
}

/**
 * 检查视频是否加载完成（.recommend-fake-video-img 消失）
 */
async function isVideoLoaded(view) {
  return await execJS(view.webContents, `!document.querySelector('.recommend-fake-video-img')`) ?? true;
}

/**
 * 等待视频加载完成
 */
async function waitForVideoLoad(view, timeout = 10000) {
  return await waitForElement(view.webContents, '.recommend-fake-video-img', timeout).then(found => !found);
}

// ========== 评论区相关 ==========

/**
 * 检查评论区是否打开（laizan 方式：#videoSideCard + clientWidth）
 */
async function isCommentOpen(view) {
  return await execJS(view.webContents, `(function(){
    const el = document.querySelector('#videoSideCard');
    if (!el) return false;
    return el.clientWidth > 0;
  })()`) ?? false;
}

/**
 * 获取评论数
 * 策略1: data-e2e="comment-icon" 旁边的数字
 * 策略2: "抢首评" 文本
 * 策略3: 评论列表中的元素数量
 */
async function getCommentCount(view) {
  return await execJS(view.webContents, `(function(){
    const body = document.body.innerText;
    // 抢首评 = 无评论
    if (body.includes('抢首评')) return 0;
    // 找评论按钮旁的数字
    const icon = document.querySelector('[data-e2e="comment-icon"]');
    if (icon) {
      const parent = icon.parentElement;
      if (parent) {
        const text = parent.innerText || '';
        const m = text.match(/(\\d+)/);
        if (m) return parseInt(m[1]);
      }
    }
    // 找包含"评"字的数字
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText || '').trim();
      if (t.match(/^\\d+$/) && el.nextElementSibling && (el.nextElementSibling.innerText||'').includes('评'))
        return parseInt(t);
    }
    return -1;
  })()`) ?? -1;
}

/**
 * 读取评论区 DOM 评论
 */
async function readDomComments(view) {
  const script = [
    '(function(){',
    '  const result = [];',
    '  const seen = new Set();',
    '  const SKIP = new Set(["回复","分享","作者赞过","收起","展开","举报","复制","删除","赞","踩","抢沙发","添加表情","查看更多回复","查看全部回复","更多回复","抢首评"]);',
    '  const items = document.querySelectorAll(\'[data-e2e="comment-list"] > div > div, [class*="comment-item"], [class*="CommentItem"]\');',
    '  for (const item of items) {',
    '    let best = "";',
    '    let nick = "";',
    '    for (const el of item.querySelectorAll("p, span, div")) {',
    '      const t = (el.innerText || "").trim();',
    '      if (!t || t.length < 3 || t.length > 500 || SKIP.has(t)) continue;',
    '      if (/^\\d+$/.test(t) || /^[\\d\\.]+万?$/.test(t)) continue;',
    '      if (t.length > best.length) best = t;',
    '    }',
    '    if (!best || best.length < 4 || seen.has(best)) continue;',
    '    seen.add(best);',
    '    const ne = item.querySelector(\'a[href*="/user/"]\');',
    '    if (ne) {',
    '      const nt = (ne.innerText || "").trim();',
    '      if (nt.length > 0 && nt.length < 30 && !SKIP.has(nt)) nick = nt;',
    '    }',
    '    result.push({ text: best, nickname: nick, comment_id: "dom_" + Math.random().toString(36).substr(2, 9), create_time: 0, ip_label: "", source: "dom" });',
    '  }',
    '  return result;',
    '})()'
  ].join('\n');
  return (await execJS(view.webContents, script)) || [];
}

/**
 * 滚动评论区加载更多
 */
async function scrollCommentPanel(view, times = 12, deltaY = 150) {
  const wc = view.webContents;
  for (let i = 0; i < times; i++) {
    await execJS(wc, `(function(){
      const panel = document.querySelector('#videoSideCard [class*="comment"], [data-e2e="comment-list"], [class*="comment-list"]');
      if (panel) panel.scrollBy(0, ${deltaY});
      else {
        const comment = document.querySelector('[class*="comment"]');
        if (comment) {
          const p = comment.closest('[style*="overflow"]') || comment.parentElement;
          if (p) p.scrollBy(0, ${deltaY});
        }
      }
    })()`);
    await sleep(1000, 2000);
  }
}

// ========== 验证码相关 ==========

/**
 * 检测验证码（laizan 方式：.second-verify-panel）
 */
async function hasCaptcha(view) {
  return await execJS(view.webContents, `(function(){
    // 策略1: .second-verify-panel
    if (document.querySelector('.second-verify-panel')) return true;
    // 策略2: 文本匹配
    const t = document.body.innerText;
    return t.includes('请完成下列验证') || t.includes('拖动完成拼图') || t.includes('人机验证') || t.includes('安全验证');
  })()`) ?? false;
}

// ========== 通用操作 ==========

async function clickByText(view, text) {
  const wc = view.webContents;
  const pos = await execJS(wc, `(function(){
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText||'').trim();
      if (t === '${text.replace(/'/g, "\\'")}') {
        const r = el.getBoundingClientRect();
        if (r.width>10 && r.height>10 && r.height<50 && r.y<200 && r.y>30)
          return { x:r.x+r.width/2, y:r.y+r.height/2 };
      }
    }
    return null;
  })()`);
  if (pos) {
    await human.mouseClick(wc, pos.x, pos.y);
    return true;
  }
  return false;
}

async function scanVideoLinks(view) {
  return (await execJS(view.webContents, `(function(){
    const links = document.querySelectorAll('a[href*="/video/"]');
    const result = [];
    const seen = new Set();
    for (const a of links) {
      const m = (a.getAttribute('href')||'').match(/\\/video\\/(\\d+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      result.push({ aid: m[1] });
    }
    return result;
  })()`) || []);
}

module.exports = {
  execJS, sleep, waitForElement,
  findSearchInput, findSearchButton, setSearchInputValue, verifySearchInput,
  getCurrentVideoInfo, isVideoLoaded, waitForVideoLoad,
  isCommentOpen, getCommentCount, readDomComments, scrollCommentPanel,
  hasCaptcha,
  clickByText, scanVideoLinks
};
