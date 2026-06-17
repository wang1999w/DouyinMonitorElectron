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

async function execJS(wc, script, timeoutMs = 15000) {
  try {
    return await Promise.race([
      wc.executeJavaScript(script),
      new Promise((_, reject) => setTimeout(() => reject(new Error('js_timeout')), timeoutMs))
    ]);
  } catch (e) {
    if (e && e.message === 'js_timeout') {
      // 超时静默处理，返回 null 避免整个流程中断
    }
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
 * 点击视频卡片（多策略降级）
 * 策略1: a[href*="/video/{aid}"] 链接
 * 策略2: [data-e2e-vid="{aid}"] 元素
 * 策略3: 页面上第一个大尺寸卡片
 */
async function clickVideoById(view, aid) {
  const wc = view.webContents;

  // 策略0: 卡片格式 card_N（新版搜索页，无视频ID的卡片）
  if (aid && aid.startsWith('card_')) {
    const cardIdx = parseInt(aid.replace('card_', ''));
    const pos = await execJS(wc, `(function(){
      // 查找所有视频卡片（有时长标记的search-result-card）
      const cards = document.querySelectorAll('.search-result-card');
      const videoCards = [];
      for (const card of cards) {
        const text = (card.innerText || '');
        const durationMatch = text.match(/^(\\d{1,2}:\\d{2})/m);
        if (durationMatch) {
          const r = card.getBoundingClientRect();
          if (r.width > 50 && r.height > 50) {
            videoCards.push(card);
          }
        }
      }
      if (${cardIdx} < videoCards.length) {
        const card = videoCards[${cardIdx}];
        card.scrollIntoView({ block: 'center' });
        const r = card.getBoundingClientRect();
        return { x: r.x+r.width/2, y: r.y+r.height/2 };
      }
      return null;
    })()`);
    if (pos) {
      await sleep(500, 1000);
      await human.mouseClick(wc, pos.x, pos.y);
      return true;
    }
    return false;
  }

  // 策略1: 链接
  let pos = await execJS(wc, `(function(){
    const links = document.querySelectorAll('a[href*="/video/${aid}"]');
    for (const a of links) {
      a.scrollIntoView({ block: 'center' });
      const r = a.getBoundingClientRect();
      if (r.width > 50 && r.height > 50)
        return { x: r.x+r.width/2, y: r.y+r.height/2 };
    }
    return null;
  })()`);

  // 策略2: data-e2e-vid
  if (!pos) {
    pos = await execJS(wc, `(function(){
      const el = document.querySelector('[data-e2e-vid="${aid}"]');
      if (el) {
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x+r.width/2, y: r.y+r.height/2 };
      }
      return null;
    })()`);
  }

  // 策略3: 搜索结果卡片中查找包含视频ID的元素
  if (!pos) {
    pos = await execJS(wc, `(function(){
      const cards = document.querySelectorAll('.search-result-card');
      for (const card of cards) {
        const links = card.querySelectorAll('a[href*="/video/${aid}"]');
        if (links.length > 0) {
          card.scrollIntoView({ block: 'center' });
          const r = card.getBoundingClientRect();
          return { x: r.x+r.width/2, y: r.y+r.height/2 };
        }
      }
      return null;
    })()`);
  }

  if (!pos) return false;
  await sleep(500, 1000);
  await human.mouseClick(wc, pos.x, pos.y);
  return true;
}

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
 * 从搜索结果列表检查视频评论数（不点击进入）
 * 在列表中可以看到评论数或"抢首评"
 * @returns {number} 评论数，0=无评论/抢首评，-1=未知
 */
async function getVideoCommentCountFromList(view, aid) {
  return await execJS(view.webContents, `(function(){
    // 找到包含该视频ID的卡片
    const links = document.querySelectorAll('a[href*="/video/${aid}"]');
    for (const a of links) {
      const card = a.closest('[class*="card"], [class*="item"], [class*="video"]') || a;
      const text = card.innerText || '';
      // 检查"抢首评"
      if (text.includes('抢首评')) return 0;
      // 检查评论数数字（通常在卡片底部）
      const nums = text.match(/(\\d+)(?:条|个)/);
      if (nums) return parseInt(nums[1]);
      // 检查单独的数字
      const el = card.querySelector('[class*="comment"], [class*="Comment"]');
      if (el) {
        const t = (el.innerText||'').trim();
        if (t.match(/^\\d+$/)) return parseInt(t);
        if (t.includes('抢首评')) return 0;
      }
    }
    return -1; // 未知
  })()`) ?? -1;
}

/**
 * 检查评论区是否打开（多选择器检测 - 比单一 #videoSideCard 更可靠）
 * 检查逻辑：
 *   1. #videoSideCard 可见（经典布局）
 *   2. .comment-input-inner-container 存在（评论输入框）
 *   3. [data-e2e="comment-list"] 存在（评论列表）
 *   4. 页面URL包含 /video/ 且右侧有评论区域元素
 */
async function isCommentOpen(view) {
  const result = await execJS(view.webContents, `(function(){
    var hit = 0;
    var el1 = document.querySelector('#videoSideCard');
    if (el1 && el1.clientWidth > 0) hit++;
    var el2 = document.querySelector('.comment-input-inner-container');
    if (el2 && el2.getBoundingClientRect().width > 0) hit++;
    var el3 = document.querySelector('[data-e2e="comment-list"]');
    if (el3 && el3.getBoundingClientRect().height > 0) hit++;
    var el4 = document.querySelector('[class*="commentPanel"], [class*="comment-panel"], [class*="CommentPanel"]');
    if (el4 && el4.getBoundingClientRect().width > 0) hit++;
    return { hit: hit, hasVideoSideCard: !!(el1 && el1.clientWidth > 0), hasInput: !!(el2 && el2.getBoundingClientRect().width > 0), hasList: !!(el3 && el3.getBoundingClientRect().height > 0) };
  })()`) ?? { hit: 0 };
  return result.hit >= 2;
}

/**
 * 点击评论图标打开评论区（比键盘快捷键更可靠）
 * 优先点击 [data-e2e="feed-comment-icon"]，兜底点击评论相关元素
 * @returns {boolean} 是否成功点击
 */
async function openCommentPanel(view) {
  return await execJS(view.webContents, `(function(){
    // 1. 优先点击 feed-comment-icon
    var selectors = [
      '[data-e2e="feed-comment-icon"]',
      '[data-e2e="comment-icon"]',
      '[class*="comment-icon"] svg',
      '[class*="CommentIcon"]',
      'div[class*="feed"] [class*="comment"] button'
    ];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        if (el) {
          var r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0) {
            el.click();
            return { ok: true, selector: selectors[i], x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
          }
        }
      } catch(e) {}
    }
    return { ok: false };
  })()`) ?? { ok: false };
}

/**
 * 获取评论数
 * 策略1: 在当前视频区域内的评论图标旁找数字（优先级最高）
 * 策略2: 在评论图标附近找"抢首评"文字（仅限图标区域，不搜索整个页面）
 * 策略3: 评论列表中的元素数量
 * 
 * ⚠️ 关键修复：不使用 document.body.innerText 全局搜索，
 *    避免被搜索结果页其他视频卡片的"抢首评"干扰
 */
async function getCommentCount(view) {
  return await execJS(view.webContents, `(function(){
    // 优先定位到当前视频区域（feed-active-video）
    const activeVideo = document.querySelector('[data-e2e="feed-active-video"]');
    // ★ 关键修复：如果 feed-active-video 不存在，直接返回-1（未知）
    // 不能回退到 document.body，否则会在搜索结果列表中找到错误的数字
    if (!activeVideo) return -1;
    const rootScope = activeVideo;

    // ===== 策略1: 找评论按钮旁的数字（优先级最高）=====
    const iconSelectors = [
      '[data-e2e="feed-comment-icon"]',
      '[data-e2e="comment-icon"]',
      '[class*="comment" i][class*="icon" i]'
    ];
    for (const sel of iconSelectors) {
      const icon = rootScope.querySelector(sel);
      if (icon) {
        // ★ 只检查 icon 自身和直接父元素，不检查更上层容器
        // 因为上层容器可能包含点赞数、收藏数等多个数字
        const targets = [
          icon,
          icon.parentElement
        ].filter(t => t !== null);
        for (const t of targets) {
          if (!t) continue;
          const text = (t.innerText || '').trim();
          // 支持 "1.5万" "3.2万" "12.3万" 格式
          const wanMatch = text.match(/([\\d.]+)万/);
          if (wanMatch) return Math.round(parseFloat(wanMatch[1]) * 10000);
          // 支持普通数字（只匹配纯数字文本，避免匹配到包含多个数字的容器）
          if (text.match(/^\\d+$/)) return parseInt(text);
        }
        // 如果图标存在但没找到纯数字，检查是否是"抢首评"
        const iconText = (icon.parentElement ? icon.parentElement.innerText : icon.innerText || '').trim();
        if (iconText.includes('抢首评')) return 0;
      }
    }

    // ===== 策略2: 在当前视频区域内精确查找"抢首评"=====
    const firstCommentEl = activeVideo.querySelector('[class*="comment" i]');
    if (firstCommentEl && (firstCommentEl.innerText || '').includes('抢首评')) {
      return 0;
    }

    // ===== 策略3: 找包含"评"字的数字（仅在当前视频区域内）=====
    const limitElements = rootScope.querySelectorAll('span, div, p');
    let checked = 0;
    for (const el of limitElements) {
      if (checked > 50) break;
      checked++;
      const t = (el.innerText || '').trim();
      if (t.length > 20) continue;
      if (t.match(/^\\d+$/) && el.nextElementSibling && (el.nextElementSibling.innerText||'').includes('评')) {
        return parseInt(t);
      }
    }

    return -1; // 未检测到（未知）
  })()`) ?? -1;
}

/**
 * 读取评论区 DOM 评论
 * 策略：完全基于 data-e2e 属性 + DOM结构推断，不依赖任何混淆class
 */
async function readDomComments(view) {
  const script = [
    '(function(){',
    '  const result = [];',
    '  const seen = new Set();',
    '  const items = document.querySelectorAll(\'[data-e2e="comment-item"]\');',
    '  for (const item of items) {',
    // ===== 1. 昵称提取 =====
    // 策略：找到 item 内 a[href*="/user/"] 中的文本，这是最可靠的
    // 如果没有，找第一个短文本span
    '    let nickname = "";',
    '    let profile_url = "";',
    '    let sec_uid = "";',
    '    const userLink = item.querySelector(\'a[href*="/user/"]\');',
    '    if (userLink) {',
    '      const href = userLink.getAttribute("href") || "";',
    '      profile_url = href.startsWith("http") ? href : (href.startsWith("//") ? "https:" + href : (href.startsWith("/") ? "https://www.douyin.com" + href : "https://www.douyin.com/" + href));',
    '      const m = profile_url.match(/\\/user\\/([A-Za-z0-9_-]+)/);',
    '      if (m) sec_uid = m[1];',
    '      const spans = userLink.querySelectorAll("span");',
    '      for (const sp of spans) {',
    '        const t = (sp.innerText || "").trim();',
    '        if (t.length > 0 && t.length < 30) { nickname = t; break; }',
    '      }',
    '      if (!nickname) nickname = (userLink.innerText || "").trim().substring(0, 30);',
    '    }',
    '    if (!nickname) {',
    '      const firstSpan = item.querySelector("span");',
    '      if (firstSpan) {',
    '        const t = (firstSpan.innerText || "").trim();',
    '        if (t.length > 0 && t.length < 30) nickname = t;',
    '      }',
    '    }',
    // ===== 2. 评论正文提取 =====
    // 核心策略：遍历item内所有span/p，找到最长的非昵称、非时间、非IP的文本
    // 这是最健壮的方式，完全不依赖class名
    '    let text = "";',
    '    const allTextEls = item.querySelectorAll("span, p, div");',
    '    let maxLen = 0;',
    '    const timePattern = /^(刚刚|\\d+秒钟?前|半分钟前|\\d+分钟?前|半小时前|\\d+小时?前|昨天|前天|\\d+天前|\\d+周前|\\d+个?月前|\\d+年前|\\d{1,2}月\\d{1,2}日|\\d{4}[-\\/]\\d{1,2}[-\\/]\\d{1,2}|\\d{1,2}:\\d{2})/;',
    '    const ipPattern = /[·\\s]+[\\u4e00-\\u9fa5]{2,4}$/;',
    '    for (const el of allTextEls) {',
    // 只取直接文本（不包含子元素的文本），避免重复
    '      let t = "";',
    '      if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {',
    '        t = (el.textContent || "").trim();',
    '      } else if (el.children.length === 0) {',
    '        t = (el.innerText || "").trim();',
    '      }',
    '      if (!t || t.length < 2) continue;',
    '      if (t === nickname) continue;',
    '      if (t.startsWith("@") && t.length < 30) continue;',
    '      if (timePattern.test(t)) continue;',
    '      if (ipPattern.test(t) && t.length < 20) continue;',
    '      if (t.match(/^\\d+$/) && t.length < 6) continue;',  // 纯数字（点赞数等）
    '      if (t.includes("回复") && t.length < 10) continue;',
    '      if (t.length > maxLen) {',
    '        text = t; maxLen = t.length;',
    '      }',
    '    }',
    // 如果上面没找到，用innerText降级（取最长去重）
    '    if (!text) {',
    '      const allSpans2 = item.querySelectorAll("span, p");',
    '      for (const sp of allSpans2) {',
    '        const t = (sp.innerText || "").trim();',
    '        if (t.length > maxLen && t.length >= 2 && t !== nickname && !t.startsWith("@") && !timePattern.test(t) && !t.match(/^\\d+$/)) {',
    '          text = t; maxLen = t.length;',
    '        }',
    '      }',
    '    }',
    '    if (!text || text.length < 2 || seen.has(text)) continue;',
    '    seen.add(text);',
    // ===== 3. 时间+IP提取 =====
    // 策略：在item内所有span中找含时间特征的文本
    '    let timeIp = "";',
    '    const allSpans3 = item.querySelectorAll("span");',
    '    for (const sp of allSpans3) {',
    '      const t = (sp.innerText || "").trim();',
    '      if (t && (t.match(/前|昨天|前天|\\d+月\\d+日|\\d{4}[-\\/]\\d/) || t.match(/\\d{1,2}:\\d{2}/)) && t.length < 40) {',
    '        timeIp = t;',
    '        break;',
    '      }',
    '    }',
    '    let ip_label = "";',
    '    const ipMatch = timeIp.match(/[·\\s]+([\\u4e00-\\u9fa5]{2,4})$/);',
    '    if (ipMatch) ip_label = ipMatch[1].trim();',
    // 时间解析（精确版 - 覆盖抖音所有时间格式）
    '    let timeText = timeIp.replace(/[·\\s]+[\\u4e00-\\u9fa5]{2,4}$/, "").trim();',
    '    let create_time = 0;',
    '    const now = Math.floor(Date.now()/1000);',
    '    const thisYear = new Date().getFullYear();',
    '    if (timeText.includes("刚刚")) {',
    '      create_time = now;',
    '    } else if (timeText.match(/(\\d+)秒钟?前/)) {',
    '      create_time = now - parseInt(timeText.match(/(\\d+)秒钟?前/)[1]);',
    '    } else if (timeText.includes("半分钟前")) {',
    '      create_time = now - 30;',
    '    } else if (timeText.match(/(\\d+)分钟?前/)) {',
    '      create_time = now - parseInt(timeText.match(/(\\d+)分钟?前/)[1]) * 60;',
    '    } else if (timeText.includes("半小时前")) {',
    '      create_time = now - 1800;',
    '    } else if (timeText.match(/(\\d+)小时?前/)) {',
    '      create_time = now - parseInt(timeText.match(/(\\d+)小时?前/)[1]) * 3600;',
    '    } else if (timeText.match(/昨天/)) {',
    '      const hm = timeText.match(/昨天\\s*(\\d{1,2}):(\\d{2})/);',
    '      const today = new Date(); today.setHours(0, 0, 0, 0);',
    '      const yesterdayStart = Math.floor(today.getTime() / 1000) - 86400;',
    '      create_time = hm ? yesterdayStart + parseInt(hm[1]) * 3600 + parseInt(hm[2]) * 60 : yesterdayStart + 12 * 3600;',
    '    } else if (timeText.match(/前天/)) {',
    '      const hm = timeText.match(/前天\\s*(\\d{1,2}):(\\d{2})/);',
    '      const today = new Date(); today.setHours(0, 0, 0, 0);',
    '      const dayBeforeStart = Math.floor(today.getTime() / 1000) - 2 * 86400;',
    '      create_time = hm ? dayBeforeStart + parseInt(hm[1]) * 3600 + parseInt(hm[2]) * 60 : dayBeforeStart + 12 * 3600;',
    '    } else if (timeText.match(/(\\d+)天前/)) {',
    '      create_time = now - parseInt(timeText.match(/(\\d+)天前/)[1]) * 86400;',
    '    } else if (timeText.match(/(\\d+)周前/)) {',
    '      create_time = now - parseInt(timeText.match(/(\\d+)周前/)[1]) * 604800;',
    '    } else if (timeText.match(/(\\d+)个?月前/)) {',
    '      create_time = now - parseInt(timeText.match(/(\\d+)个?月前/)[1]) * 2592000;',
    '    } else if (timeText.match(/(\\d+)年前/)) {',
    '      create_time = now - parseInt(timeText.match(/(\\d+)年前/)[1]) * 31536000;',
    '    } else if (timeText.match(/(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2}):(\\d{2})/)) {',
    '      const dm = timeText.match(/(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2}):(\\d{2})/);',
    '      const d = new Date(thisYear, parseInt(dm[1])-1, parseInt(dm[2]), parseInt(dm[3]), parseInt(dm[4]));',
    '      if (d.getTime() > Date.now()) d.setFullYear(thisYear - 1);',
    '      create_time = Math.floor(d.getTime() / 1000);',
    '    } else if (timeText.match(/(\\d{1,2})月(\\d{1,2})日/)) {',
    '      const dm = timeText.match(/(\\d{1,2})月(\\d{1,2})日/);',
    '      const d = new Date(thisYear, parseInt(dm[1])-1, parseInt(dm[2]));',
    '      if (d.getTime() > Date.now()) d.setFullYear(thisYear - 1);',
    '      create_time = Math.floor(d.getTime() / 1000);',
    '    } else if (timeText.match(/(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})\\s*(\\d{1,2}):(\\d{2})/)) {',
    '      const dm = timeText.match(/(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})\\s*(\\d{1,2}):(\\d{2})/);',
    '      create_time = Math.floor(new Date(parseInt(dm[1]), parseInt(dm[2])-1, parseInt(dm[3]), parseInt(dm[4]), parseInt(dm[5])).getTime() / 1000);',
    '    } else if (timeText.match(/(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})/)) {',
    '      const dm = timeText.match(/(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})/);',
    '      create_time = Math.floor(new Date(parseInt(dm[1]), parseInt(dm[2])-1, parseInt(dm[3])).getTime() / 1000);',
    '    } else if (timeText.match(/(\\d{1,2})[-\\/](\\d{1,2})\\s+(\\d{1,2}):(\\d{2})/)) {',
    '      const dm = timeText.match(/(\\d{1,2})[-\\/](\\d{1,2})\\s+(\\d{1,2}):(\\d{2})/);',
    '      const d = new Date(thisYear, parseInt(dm[1])-1, parseInt(dm[2]), parseInt(dm[3]), parseInt(dm[4]));',
    '      if (d.getTime() > Date.now()) d.setFullYear(thisYear - 1);',
    '      create_time = Math.floor(d.getTime() / 1000);',
    '    } else if (timeText.match(/^(\\d{1,2})[-\\/](\\d{1,2})$/)) {',
    '      const dm = timeText.match(/^(\\d{1,2})[-\\/](\\d{1,2})$/);',
    '      const d = new Date(thisYear, parseInt(dm[1])-1, parseInt(dm[2]));',
    '      if (d.getTime() > Date.now()) d.setFullYear(thisYear - 1);',
    '      create_time = Math.floor(d.getTime() / 1000);',
    '    }',
    // ===== 4. 点赞数 =====
    '    let digg_count = 0;',
    '    const allSmallSpans = item.querySelectorAll("span");',
    '    for (const sp of allSmallSpans) {',
    '      const t = (sp.innerText || "").trim();',
    '      if (t.match(/^\\d+$/) && t.length < 6 && sp.querySelector("span") === null) {',
    '        const parent = sp.parentElement;',
    '        if (parent && (parent.querySelector("svg") || parent.querySelector("path") || (parent.className || "").includes("digg") || (parent.className || "").includes("like"))) {',
    '          digg_count = parseInt(t);',
    '          break;',
    '        }',
    '      }',
    '    }',
    '    result.push({',
    '      text, nickname, ip_label, create_time, profile_url, sec_uid, digg_count,',
    '      comment_id: "dom_" + Math.random().toString(36).substr(2, 9)',
    '    });',
    '  }',
    '  return result;',
    '})()'
  ].join('\n');
  return (await execJS(view.webContents, script)) || [];
}

/**
 * 滚动评论区加载更多
 * ⚠️ 关键安全规则：
 *  1. 只滚动明确识别到的评论区容器，找不到就不滚动
 *  2. 不做"找右侧可滚动容器"的兜底，避免误滚到视频区域
 *  3. 同时使用 wheelEvent + scrollBy，兼容虚拟滚动组件
 */
async function scrollCommentPanel(view, times = 3, deltaY = 400) {
  const wc = view.webContents;
  for (let i = 0; i < times; i++) {
    const scrolled = await execJS(wc, `(function(){
      // 1. 优先找评论列表（最可靠）
      const list = document.querySelector('[data-e2e="comment-list"]');
      let scrollTarget = null;

      if (list) {
        // 向上查找overflow: scroll/auto的父元素
        let p = list;
        while (p && p !== document.body) {
          const s = getComputedStyle(p);
          if (s.overflowY === 'auto' || s.overflowY === 'scroll') {
            scrollTarget = p;
            break;
          }
          p = p.parentElement;
        }
        // 如果没找到滚动容器，用list本身
        if (!scrollTarget) scrollTarget = list;
      }

      // 2. 降级：找明确的评论区容器（不使用模糊的"可滚动元素"搜索）
      if (!scrollTarget) {
        scrollTarget = document.querySelector('#videoSideCard') ||
                       document.querySelector('.comment-mainContent');
      }

      if (!scrollTarget) return false;

      // 验证：滚动目标必须在页面右侧（避免误操作左侧视频区）
      const rect = scrollTarget.getBoundingClientRect();
      const vpWidth = window.innerWidth || 800;
      if (rect.left < vpWidth * 0.3) {
        // 目标在页面左侧/中部，可能不是评论区，拒绝滚动
        return false;
      }

      // 执行滚动：方式1 - wheel事件（虚拟滚动组件监听这个）
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: ${deltaY},
        deltaMode: 0,
        bubbles: true,
        cancelable: true
      });
      scrollTarget.dispatchEvent(wheelEvent);

      // 执行滚动：方式2 - scrollBy（传统DOM滚动）
      scrollTarget.scrollBy({ top: ${deltaY}, behavior: 'smooth' });
      return true;
    })()`) ?? false;

    if (!scrolled) break; // 找不到合法滚动目标，停止滚动
    await sleep(800, 1500);
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
    const result = [];
    const seen = new Set();

    // 策略1: a[href*="/video/"] 链接（旧版搜索页）
    const links = document.querySelectorAll('a[href*="/video/"]');
    for (const a of links) {
      const m = (a.getAttribute('href')||'').match(/\\/video\\/(\\d+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      result.push({ aid: m[1] });
    }

    // 策略2: .search-result-card 卡片（新版搜索页 - 综合tab）
    // 视频卡片内可能有隐藏的a链接或data属性包含视频ID
    if (result.length === 0) {
      const cards = document.querySelectorAll('.search-result-card');
      for (const card of cards) {
        // 尝试从卡片内的a链接获取视频ID
        const cardLinks = card.querySelectorAll('a[href*="/video/"]');
        if (cardLinks.length > 0) {
          const m = (cardLinks[0].getAttribute('href')||'').match(/\\/video\\/(\\d+)/);
          if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            result.push({ aid: m[1] });
            continue;
          }
        }
        // 尝试从data属性获取视频ID
        const vid = card.getAttribute('data-e2e-vid') || card.getAttribute('data-vid') || '';
        if (vid && !seen.has(vid)) {
          seen.add(vid);
          result.push({ aid: vid, isCard: true });
          continue;
        }
        // 尝试从卡片内所有元素的data属性获取
        const allEls = card.querySelectorAll('[data-e2e-vid], [data-vid]');
        for (const el of allEls) {
          const v = el.getAttribute('data-e2e-vid') || el.getAttribute('data-vid') || '';
          if (v && !seen.has(v)) {
            seen.add(v);
            result.push({ aid: v, isCard: true });
            break;
          }
        }
      }
    }

    // 策略3: 搜索结果中的视频卡片（通过class名和结构识别）
    if (result.length === 0) {
      // 查找所有可能是视频卡片的元素（包含时长标记如"00:20"）
      const allCards = document.querySelectorAll('[class*="search-result"], [class*="SearchResult"], [class*="video-card"], [class*="VideoCard"]');
      for (const card of allCards) {
        const text = (card.innerText || '');
        // 视频卡片通常有时长标记 (XX:XX格式)
        const durationMatch = text.match(/^(\\d{1,2}:\\d{2})/m);
        if (!durationMatch) continue;  // 跳过非视频卡片（如图文）
        // 获取卡片位置用于点击
        const r = card.getBoundingClientRect();
        if (r.width > 50 && r.height > 50) {
          const cardIdx = Array.from(card.parentElement?.children || []).indexOf(card);
          result.push({ aid: 'card_' + cardIdx, isCard: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
        }
      }
    }

    return result;
  })()`) || []);
}

// ===== 新增：页面状态检测与精确数据提取 =====

/**
 * 检测当前页面类型
 * @returns {Promise<string>} 'search_result' | 'video_detail' | 'home' | 'unknown'
 */
async function getPageState(view) {
  const wc = view.webContents;
  try {
    const result = await execJS(wc, `(function(){
      const url = location.href;
      const hasFeedActiveVideo = !!document.querySelector('[data-e2e="feed-active-video"]');
      const hasSearchInput = !!document.querySelector('[data-e2e="searchbar-input"]') || !!document.querySelector('input[placeholder*="搜索"]');
      const hasSearchTabs = !!document.querySelector('[role="tablist"]') || document.querySelectorAll('[data-e2e^="search"]').length > 1;
      const isVideoUrl = url.includes('/video/');
      const isSearchUrl = url.includes('/search/') || url.includes('keyword=');
      
      if (isVideoUrl || hasFeedActiveVideo) return 'video_detail';
      if (isSearchUrl || (hasSearchInput && hasSearchTabs)) return 'search_result';
      if (url === 'https://www.douyin.com/' || url === 'https://douyin.com/') return 'home';
      return 'unknown';
    })()`);
    return result || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

/**
 * 获取当前视频ID（从URL和DOM双重验证）
 * @returns {Promise<string>} 视频ID，失败返回空字符串
 */
async function getCurrentVideoId(view) {
  const wc = view.webContents;
  try {
    return await execJS(wc, `(function(){
      // 方式1: URL
      const url = location.href;
      const urlMatch = url.match(/\\/video\\/(\\d+)/);
      if (urlMatch) return urlMatch[1];
      // 方式2: feed-active-video
      const el = document.querySelector('[data-e2e="feed-active-video"]');
      if (el) {
        const vid = el.getAttribute('data-e2e-vid') || '';
        if (vid) return vid;
      }
      // 方式3: 页面中查找视频链接
      const links = document.querySelectorAll('a[href*="/video/"]');
      for (const a of links) {
        const r = a.getBoundingClientRect();
        if (r.width > 100 && r.height > 100) {
          const m = (a.getAttribute('href') || '').match(/\\/video\\/(\\d+)/);
          if (m) return m[1];
        }
      }
      return '';
    })()`);
  } catch (e) {
    return '';
  }
}

/**
 * 验证当前页面是否是指定视频的详情页
 * @param {object} view 
 * @param {string} expectedAid - 预期视频ID
 * @returns {Promise<boolean>}
 */
async function verifyVideoPage(view, expectedAid) {
  if (!expectedAid || expectedAid.startsWith('card_')) return true;
  const currentAid = await getCurrentVideoId(view);
  return currentAid === expectedAid;
}

/**
 * 精确获取评论项的时间文本（从多个位置尝试）
 * 问题：之前的选择器可能匹配到视频发布时间而不是评论时间
 */
async function getCommentTimeTextFromItem(view, itemIndex) {
  const wc = view.webContents;
  try {
    return await execJS(wc, `(function(){
      const items = document.querySelectorAll('[data-e2e="comment-item"], [class*="comment-item"]');
      if (!items[${itemIndex}]) return '';
      const item = items[${itemIndex}];
      
      // 策略：在评论项内找时间特征文本
      // 抖音评论时间通常在昵称下方、评论文本上方，格式为"X天前"等
      // 同时要避免匹配到视频发布时间
      
      const allTextNodes = [];
      // 遍历所有子元素文本
      function collectText(el, depth) {
        if (depth > 3) return;
        for (const child of el.children) {
          const tag = child.tagName.toLowerCase();
          // 跳过按钮、图标等元素
          if (child.querySelector('svg, img, button')) continue;
          const text = (child.innerText || '').trim();
          if (text && text.length <= 20 && !text.includes('回复')) {
            allTextNodes.push({ text, tag, classes: child.className || '' });
          }
          collectText(child, depth + 1);
        }
      }
      collectText(item, 0);
      
      // 从收集到的文本中找时间特征
      const timePattern = /(刚刚|\\d+秒钟?前|半分钟前|\\d+分钟?前|半小时前|\\d+小时?前|昨天|前天|\\d+天前|\\d+周前|\\d+个?月前|\\d+年前|\\d{1,2}月\\d{1,2}日)/;
      for (const t of allTextNodes) {
        if (timePattern.test(t.text)) return t.text;
      }
      return '';
    })()`);
  } catch (e) {
    return '';
  }
}

/**
 * 尝试在评论区切换到"最新"排序（如果有此选项）
 * 抖音评论区可能有"最热/最新"等排序选项
 * @returns {Promise<boolean>} 是否成功切换
 */
/**
 * 切换评论区排序方式（支持用户自由预设）
 * @param {object} view - Electron BrowserView
 * @param {string} sortMode - 排序模式: 'newest'（最新/时间）| 'hottest'（最热/点赞）| 'default'（默认/不切换）
 * @returns {boolean} 是否成功切换
 */
async function trySwitchCommentSort(view, sortMode) {
  const wc = view.webContents;
  // default 模式：不做任何切换，保持默认排序
  if (!sortMode || sortMode === 'default') {
    logger.info('[DOM] 评论排序: 使用默认（不切换）');
    return false;
  }
  try {
    // 根据用户选择的排序模式，确定要点击的文本标签
    let targetTexts;
    if (sortMode === 'newest') {
      // 时间模式首选：按最新评论排序
      targetTexts = ['最新', '按时间', '时间排序', '时间'];
    } else if (sortMode === 'hottest') {
      // 数量模式首选：按最热/最多点赞排序
      targetTexts = ['最热', '按热度', '最热评论', '热度排序', '点赞'];
    } else {
      targetTexts = [sortMode];
    }

    const result = await execJS(wc, `(function(){
      const candidates = document.querySelectorAll('button, div[role="button"], span, a');
      const targets = ${JSON.stringify(targetTexts)};
      for (const el of candidates) {
        const text = (el.innerText || '').trim();
        if (targets.includes(text)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.width < 200 && r.height < 100) {
            const isActive = (el.className || '').includes('active') 
              || (el.className || '').includes('selected')
              || el.getAttribute('aria-selected') === 'true';
            if (!isActive) {
              el.click();
              return { clicked: true, text: text, alreadyActive: false };
            } else {
              return { clicked: true, text: text, alreadyActive: true };
            }
          }
        }
      }
      return { clicked: false };
    })()`);
    if (result && result.clicked) {
      logger.info(`[DOM] 评论排序: ${result.text} (模式: ${sortMode})${result.alreadyActive ? ' (已激活)' : ' (已切换)'}`);
      return true;
    }
    logger.info(`[DOM] 评论区未发现排序切换选项（模式: ${sortMode}），使用默认排序`);
    return false;
  } catch (e) {
    logger.info(`[DOM] 评论排序切换失败: ${e.message}`);
    return false;
  }
}

/**
 * 旧函数（向后兼容）：等同于 trySwitchCommentSort(view, 'newest')
 */
async function trySwitchCommentToLatest(view) {
  return await trySwitchCommentSort(view, 'newest');
}

/**
 * 解析相对时间文本为时间戳
 * 专门用于 DOM 评论时间解析
 * @param {string} timeText - 如"3天前"、"2小时前"等
 * @returns {number} Unix时间戳（秒）
 */
function parseRelativeTime(timeText) {
  if (!timeText) return 0;
  try {
    const now = Math.floor(Date.now() / 1000);
    const t = timeText.trim();
    
    if (t.includes('刚刚')) return now;
    if (t.includes('半分钟前')) return now - 30;
    if (t.includes('半小时前')) return now - 1800;
    
    const secMatch = t.match(/(\\d+)秒钟?前/);
    if (secMatch) return now - parseInt(secMatch[1]);
    
    const minMatch = t.match(/(\\d+)分钟?前/);
    if (minMatch) return now - parseInt(minMatch[1]) * 60;
    
    const hourMatch = t.match(/(\\d+)小时?前/);
    if (hourMatch) return now - parseInt(hourMatch[1]) * 3600;
    
    const dayMatch = t.match(/(\\d+)天前/);
    if (dayMatch) return now - parseInt(dayMatch[1]) * 86400;
    
    const weekMatch = t.match(/(\\d+)周前/);
    if (weekMatch) return now - parseInt(weekMatch[1]) * 604800;
    
    const monthMatch = t.match(/(\\d+)个?月前/);
    if (monthMatch) return now - parseInt(monthMatch[1]) * 2592000;
    
    const yearMatch = t.match(/(\\d+)年前/);
    if (yearMatch) return now - parseInt(yearMatch[1]) * 31536000;
    
    if (t.includes('昨天')) {
      const hmMatch = t.match(/昨天\\s*(\\d{1,2}):(\\d{2})/);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const yesterdayStart = Math.floor(today.getTime() / 1000) - 86400;
      if (hmMatch) return yesterdayStart + parseInt(hmMatch[1]) * 3600 + parseInt(hmMatch[2]) * 60;
      return yesterdayStart + 12 * 3600;
    }
    
    if (t.includes('前天')) {
      const hmMatch = t.match(/前天\\s*(\\d{1,2}):(\\d{2})/);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const twoDaysAgo = Math.floor(today.getTime() / 1000) - 2 * 86400;
      if (hmMatch) return twoDaysAgo + parseInt(hmMatch[1]) * 3600 + parseInt(hmMatch[2]) * 60;
      return twoDaysAgo + 12 * 3600;
    }
    
    // 具体日期格式：如 "6月17日" 或 "6月17日 14:30"
    const dateHourMatch = t.match(/(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2}):(\\d{2})/);
    if (dateHourMatch) {
      const d = new Date(new Date().getFullYear(), parseInt(dateHourMatch[1])-1, parseInt(dateHourMatch[2]), parseInt(dateHourMatch[3]), parseInt(dateHourMatch[4]));
      if (d.getTime() > Date.now()) d.setFullYear(d.getFullYear() - 1);
      return Math.floor(d.getTime() / 1000);
    }
    
    const dateMatch = t.match(/(\\d{1,2})月(\\d{1,2})日/);
    if (dateMatch) {
      const d = new Date(new Date().getFullYear(), parseInt(dateMatch[1])-1, parseInt(dateMatch[2]));
      if (d.getTime() > Date.now()) d.setFullYear(d.getFullYear() - 1);
      return Math.floor(d.getTime() / 1000);
    }
    
    return 0;
  } catch (e) {
    return 0;
  }
}

// 抖音号缓存（避免重复fetch同一用户主页）
const _douyinIdCache = new Map();
const MAX_DOUYIN_ID_CACHE = 500;

/**
 * 通过fetch请求用户主页获取抖音号
 * 不需要导航页面，直接在当前页面用fetch获取主页HTML并解析
 * 带缓存：同一profileUrl只fetch一次
 * @param {WebContents} wc - webContents
 * @param {string} profileUrl - 用户主页URL
 * @returns {Promise<string>} 抖音号（如 Y18356857035），失败返回空字符串
 */
async function fetchDouyinId(wc, profileUrl) {
  if (!profileUrl || !wc) return '';

  // 检查缓存
  if (_douyinIdCache.has(profileUrl)) {
    return _douyinIdCache.get(profileUrl);
  }

  try {
    const douyinId = await execJS(wc, `(async function(){
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch('${profileUrl.replace(/'/g, "\\'")}', {
          credentials: 'include',
          headers: { 'Accept': 'text/html' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!resp.ok) return '';
        const html = await resp.text();

        // 方式1: 从 RENDER_DATA 中提取（抖音SSR数据）
        const renderMatch = html.match(/id="RENDER_DATA"[^>]*>([\\s\\S]*?)<\\/script>/);
        if (renderMatch) {
          try {
            const decoded = decodeURIComponent(renderMatch[1]);
            // 优先 unique_id（抖音号），其次 short_id
            const uidMatch = decoded.match(/"unique_id"\\s*:\\s*"([^"]+)"/);
            if (uidMatch && uidMatch[1] && uidMatch[1] !== '0') return uidMatch[1];
            const shortMatch = decoded.match(/"short_id"\\s*:\\s*"([^"]+)"/);
            if (shortMatch && shortMatch[1] && shortMatch[1] !== '0') return shortMatch[1];
          } catch(e) {}
        }

        // 方式2: 从 __NEXT_DATA__ 中提取
        const nextMatch = html.match(/__NEXT_DATA__[^>]*>([\\s\\S]*?)<\\/script>/);
        if (nextMatch) {
          try {
            const decoded = nextMatch[1];
            const uidMatch = decoded.match(/"unique_id"\\s*:\\s*"([^"]+)"/);
            if (uidMatch && uidMatch[1] && uidMatch[1] !== '0') return uidMatch[1];
            const shortMatch = decoded.match(/"short_id"\\s*:\\s*"([^"]+)"/);
            if (shortMatch && shortMatch[1] && shortMatch[1] !== '0') return shortMatch[1];
          } catch(e) {}
        }

        // 方式3: 从页面中的抖音号文本提取（多种格式）
        const patterns = [
          /抖音号[：:]\\s*([A-Za-z0-9_.-]+)/,
          /抖音号[：:]\\s*<[^>]*>([A-Za-z0-9_.-]+)<\\/[^>]+>/,
          /douyinId[：:]\\s*([A-Za-z0-9_.-]+)/,
          /"unique_id"\\s*:\\s*"([A-Za-z0-9_.-]+)"/,
          /"short_id"\\s*:\\s*"([A-Za-z0-9_.-]+)"/
        ];
        for (const p of patterns) {
          const m = html.match(p);
          if (m && m[1] && m[1] !== '0' && m[1].length >= 2) return m[1];
        }

        return '';
      } catch(e) { return ''; }
    })()`);
    const id = douyinId || '';
    // 写入缓存（包括空结果，避免重复fetch失败的用户）
    _douyinIdCache.set(profileUrl, id);
    if (_douyinIdCache.size > MAX_DOUYIN_ID_CACHE) {
      const firstKey = _douyinIdCache.keys().next().value;
      _douyinIdCache.delete(firstKey);
    }
    if (id) logger.info(`[DOM] 抖音号获取成功: ${id} (${profileUrl.substring(0, 50)})`);
    return id;
  } catch (e) {
    return '';
  }
}

module.exports = {
  execJS, sleep, waitForElement,
  findSearchInput, findSearchButton, setSearchInputValue, verifySearchInput,
  clickVideoById, getCurrentVideoInfo, isVideoLoaded, waitForVideoLoad,
  getVideoCommentCountFromList,
  isCommentOpen, openCommentPanel, getCommentCount, readDomComments, scrollCommentPanel,
  hasCaptcha,
  clickByText, scanVideoLinks,
  fetchDouyinId,
  getPageState, getCurrentVideoId, verifyVideoPage,
  getCommentTimeTextFromItem, trySwitchCommentToLatest, trySwitchCommentSort,
  parseRelativeTime
};
