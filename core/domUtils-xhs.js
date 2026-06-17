/**
 * 小红书 DOM 操作工具
 *
 * 核心选择器：
 *   - 搜索框：input[placeholder*="搜索"]
 *   - 搜索按钮：.search-btn
 *   - 笔记卡片：a[href*="/explore/"] 或 .note-item
 *   - 评论区：.comments-el 或 .note-scroller
 *   - 评论项：.comment-item 或 .comment-inner
 *   - 验证码：.geetest_* 或 .captcha-*
 */

const { getLogger } = require('./logger');
const logger = getLogger('XHS-DomUtils');

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

async function findSearchInput(view) {
  // 小红书首页搜索框真实DOM（登录后）：
  // 可见搜索区: div.search-area.search-area-opacity (x=24, y=62, w=782, h=117)
  // 搜索容器: div.wendian-wrapper.search-input.large#search-input-in-feeds
  // 实际输入元素: textarea.textarea (placeholder="搜索或输入任何问题")
  // 注意：#search-input 是隐藏的（顶部header），#search-input-in-feeds 才是可见的
  return await execJS(view.webContents, `(function(){
    // 优先查找可见的 textarea（登录后首页搜索框）
    var textareas = document.querySelectorAll('textarea.textarea, textarea[name="aiSearchTextarea"]');
    for (var i = 0; i < textareas.length; i++) {
      var t = textareas[i];
      var r = t.getBoundingClientRect();
      if (r.width > 50 && r.height > 10) {
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height), strategy: 'textarea', tag: 'textarea' };
      }
    }
    // 降级：查找可见的 input.search-input（未登录首页）
    var inputs = document.querySelectorAll('input.search-input');
    for (var j = 0; j < inputs.length; j++) {
      var inp = inputs[j];
      var ir = inp.getBoundingClientRect();
      if (ir.width > 0 && ir.height > 0) {
        return { x: Math.round(ir.x + ir.width/2), y: Math.round(ir.y + ir.height/2), w: Math.round(ir.width), h: Math.round(ir.height), strategy: 'input', tag: 'input' };
      }
    }
    // 最后降级：查找 #search-input-in-feeds 容器
    var feedsInput = document.getElementById('search-input-in-feeds');
    if (feedsInput) {
      var fr = feedsInput.getBoundingClientRect();
      if (fr.width > 50 && fr.height > 10) {
        return { x: Math.round(fr.x + fr.width/2), y: Math.round(fr.y + fr.height/2), w: Math.round(fr.width), h: Math.round(fr.height), strategy: 'feeds-container', tag: 'div' };
      }
    }
    return null;
  })()`);
}

async function findSearchButton(view) {
  // 小红书搜索图标：div.search-icon (未登录) 或 搜索按钮在 textarea 下方
  return await execJS(view.webContents, `(function(){
    // 优先用div.search-icon（未登录首页的搜索图标）
    var e = document.querySelector('div.search-icon');
    if (e) {
      var r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height), strategy: 'icon' };
      }
    }
    // 登录后首页：查找搜索区域内的可点击按钮（通常在 textarea 下方右侧）
    var searchArea = document.querySelector('.search-area, .input-box.search-box-in-content');
    if (searchArea) {
      var btns = searchArea.querySelectorAll('button, [role="button"], [class*="btn"], [class*="search"], [class*="submit"]');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var br = b.getBoundingClientRect();
        if (br.width > 10 && br.height > 10) {
          return { x: Math.round(br.x + br.width/2), y: Math.round(br.y + br.height/2), w: Math.round(br.width), h: Math.round(br.height), strategy: 'area-btn' };
        }
      }
    }
    // 降级：查找可见的搜索按钮
    var allBtns = document.querySelectorAll('button, div[role="button"]');
    for (var j = 0; j < allBtns.length; j++) {
      var bb = allBtns[j];
      var txt = (bb.innerText||'').trim();
      if (txt === '搜索' || txt === 'Search') {
        var bbr = bb.getBoundingClientRect();
        if (bbr.width > 10 && bbr.height > 10 && bbr.y < 200) {
          return { x: Math.round(bbr.x + bbr.width/2), y: Math.round(bbr.y + bbr.height/2), strategy: 'text' };
        }
      }
    }
    return null;
  })()`);
}

async function setSearchInputValue(view, value) {
  // 基于真实DOM：textarea.textarea (placeholder="搜索或输入任何问题")
  return await execJS(view.webContents, `(function(){
    // 优先查找可见的 textarea
    var textareas = document.querySelectorAll('textarea.textarea, textarea[name="aiSearchTextarea"]');
    var target = null;
    for (var i = 0; i < textareas.length; i++) {
      var r = textareas[i].getBoundingClientRect();
      if (r.width > 50 && r.height > 10) { target = textareas[i]; break; }
    }
    // 降级：查找可见的 input.search-input
    if (!target) {
      var inputs = document.querySelectorAll('input.search-input');
      for (var j = 0; j < inputs.length; j++) {
        var ir = inputs[j].getBoundingClientRect();
        if (ir.width > 0 && ir.height > 0) { target = inputs[j]; break; }
      }
    }
    if (!target) return false;
    target.focus();
    target.value = '';
    // 使用原生 setter 触发 Vue/React 响应
    var proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeSetter.call(target, '${value.replace(/'/g, "\\'")}');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

// ========== 笔记相关 ==========

async function clickNoteById(view, noteId) {
  // 获取笔记链接位置，返回坐标供humanClick使用（避免直接DOM click被检测）
  const pos = await execJS(view.webContents, `(function(){
    const links = document.querySelectorAll('a[href*="/explore/${noteId}"], a[href*="/search_result/${noteId}"], a[href*="/discovery/item/${noteId}"]');
    for (const a of links) {
      const r = a.getBoundingClientRect();
      if (r.width > 30 && r.height > 30) {
        a.scrollIntoView({ block: 'center' });
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
      }
    }
    return null;
  })()`);
  return pos;
}

async function scanNoteLinks(view) {
  return (await execJS(view.webContents, `(function(){
    // 小红书笔记卡片: section.note-item
    // 首页链接: /explore/{noteId}
    // 搜索结果页链接: /search_result/{noteId}
    // 标题: a.title > span
    // 作者: a.author div.name 或 a.author span.name
    // 作者主页: a.author[href]
    const items = document.querySelectorAll('section.note-item');
    const result = [];
    const seen = new Set();
    for (const item of items) {
      // 从 a.cover 或 a.title 的 href 提取 noteId
      // 支持首页 /explore/ 和搜索页 /search_result/ 两种URL格式
      const coverLink = item.querySelector('a.cover[href*="/explore/"], a.cover[href*="/search_result/"], a.cover[href*="/discovery/item/"]');
      const titleLink = item.querySelector('a.title[href*="/explore/"], a.title[href*="/search_result/"], a.title[href*="/discovery/item/"]');
      const link = coverLink || titleLink;
      if (!link) continue;
      const href = link.getAttribute('href') || '';
      const m = href.match(/\\/explore\\/([a-f0-9]+)/) || href.match(/\\/search_result\\/([a-f0-9]+)/) || href.match(/\\/discovery\\/item\\/([a-f0-9]+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      // 提取标题（多选择器 fallback）
      let title = '';
      const titleEl = item.querySelector('a.title span') ||
                       item.querySelector('a.title') ||
                       item.querySelector('.note-title') ||
                       item.querySelector('.title') ||
                       item.querySelector('.desc');
      if (titleEl) title = (titleEl.innerText || titleEl.textContent || '').trim();
      // 提取作者信息
      let author = '';
      let authorUrl = '';
      const authorLink = item.querySelector('a.author') || item.querySelector('[class*="author"]');
      if (authorLink) {
        const nameEl = authorLink.querySelector('span.name, div.name, .name, .author-name');
        if (nameEl) author = (nameEl.innerText || nameEl.textContent || '').trim();
        authorUrl = authorLink.getAttribute('href') || '';
      }
      result.push({ noteId: m[1], title: title, author: author, authorUrl: authorUrl });
    }
    return result;
  })()`) || []);
}

// ========== 评论区相关 ==========

async function getCommentCount(view) {
  return await execJS(view.webContents, `(function(){
    // 尝试从互动信息获取
    const interactEl = document.querySelector('.interact-container, .engage-bar');
    if (interactEl) {
      const text = interactEl.innerText || '';
      const m = text.match(/(\\d+)/);
      if (m) return parseInt(m[1]);
    }
    // 尝试从评论数量标签获取
    const countEl = document.querySelector('.count, .total, [class*="comment-count"], [class*="count"]');
    if (countEl) {
      const text = (countEl.innerText || '').trim();
      const m = text.match(/(\\d+)/);
      if (m) return parseInt(m[1]);
    }
    return -1;
  })()`) ?? -1;
}

async function readDomComments(view) {
  const script = `(function(){
    const result = [];
    const seen = new Set();
    // 小红书评论DOM结构:
    // div.comment-item[id="comment-{commentId}"]
    //   div.comment-inner-container
    //     div.avatar > a[href*="/user/profile/"] > img
    //     div.right
    //       div.author-wrapper > div.author > a.name[href][data-user-id]
    //       div.content > span.note-text
    //       div.info > div.date > span(时间) + span.location(IP)
    //       div.info > div.interactions > div.like > span.count
    const items = document.querySelectorAll('div.comment-item');
    for (const item of items) {
      // 评论ID
      let commentId = '';
      const idMatch = (item.id || '').match(/comment-(.+)/);
      if (idMatch) commentId = idMatch[1];

      // 昵称 + 用户主页 + UID
      let nickname = '';
      let profileUrl = '';
      let uid = '';
      const nameLink = item.querySelector('a.name');
      if (nameLink) {
        nickname = (nameLink.innerText || '').trim();
        const href = nameLink.getAttribute('href') || '';
        profileUrl = href.startsWith('http') ? href : 'https://www.xiaohongshu.com' + href;
        uid = nameLink.getAttribute('data-user-id') || '';
        if (!uid) {
          const m = profileUrl.match(/\\/user\\/profile\\/([a-f0-9]+)/);
          if (m) uid = m[1];
        }
      }

      // 评论内容
      let text = '';
      const noteText = item.querySelector('span.note-text');
      if (noteText) text = (noteText.innerText || '').trim();
      if (!text) {
        const contentEl = item.querySelector('.content');
        if (contentEl) text = (contentEl.innerText || '').trim();
      }
      if (!text || text.length < 2 || seen.has(text)) continue;
      seen.add(text);

      // 时间 + IP属地
      let timeText = '';
      let ipLabel = '';
      const dateEl = item.querySelector('.info .date');
      if (dateEl) {
        const spans = dateEl.querySelectorAll('span');
        if (spans.length >= 1) timeText = (spans[0].innerText || '').trim();
        if (spans.length >= 2) ipLabel = (spans[1].innerText || '').trim();
      }

      // 点赞数
      let likeCount = 0;
      const countEl = item.querySelector('.interactions .like .count');
      if (countEl) {
        const m = (countEl.innerText || '').match(/(\\d+)/);
        if (m) likeCount = parseInt(m[1]);
      }

      result.push({
        text, nickname, ip_label: ipLabel, profile_url: profileUrl,
        uid, like_count: likeCount,
        create_time: parseTimeText(timeText),
        comment_id: commentId || ('dom_' + Math.random().toString(36).substr(2, 9)),
        source: 'dom',
        platform: 'xhs'
      });
    }
    return result;

    function parseTimeText(t) {
      if (!t) return 0;
      const now = Math.floor(Date.now()/1000);
      const thisYear = new Date().getFullYear();
      // 1) "刚刚"
      if (t.includes('刚刚')) return now;
      // 2) "X秒/秒钟前"
      const secMatch = t.match(/(\\d+)秒钟?前/);
      if (secMatch) return now - parseInt(secMatch[1]);
      // 3) "半分钟前"
      if (t.includes('半分钟前')) return now - 30;
      // 4) "X分/分钟前"
      const minMatch = t.match(/(\\d+)分钟?前/);
      if (minMatch) return now - parseInt(minMatch[1]) * 60;
      // 5) "半小时前"
      if (t.includes('半小时前')) return now - 1800;
      // 6) "X小时前"
      const hourMatch = t.match(/(\\d+)小时?前/);
      if (hourMatch) return now - parseInt(hourMatch[1]) * 3600;
      // 7) "今天 HH:MM" 或 "今天HH:MM"
      const todayMatch = t.match(/今天\\s*(\\d{1,2}):(\\d{2})/);
      if (todayMatch) {
        const d = new Date(); d.setHours(parseInt(todayMatch[1]), parseInt(todayMatch[2]), 0, 0);
        return Math.floor(d.getTime()/1000);
      }
      // 8) "昨天 HH:MM" 或 "昨天"
      if (t.match(/昨天/)) {
        const hm = t.match(/昨天\\s*(\\d{1,2}):(\\d{2})/);
        const today = new Date(); today.setHours(0,0,0,0);
        const yesterdayStart = Math.floor(today.getTime()/1000) - 86400;
        if (hm) return yesterdayStart + parseInt(hm[1]) * 3600 + parseInt(hm[2]) * 60;
        return yesterdayStart + 12 * 3600;
      }
      // 9) "前天"
      if (t.match(/前天/)) {
        const hm = t.match(/前天\\s*(\\d{1,2}):(\\d{2})/);
        const today = new Date(); today.setHours(0,0,0,0);
        const dayBeforeStart = Math.floor(today.getTime()/1000) - 2 * 86400;
        if (hm) return dayBeforeStart + parseInt(hm[1]) * 3600 + parseInt(hm[2]) * 60;
        return dayBeforeStart + 12 * 3600;
      }
      // 10) "X天前"
      const dayMatch = t.match(/(\\d+)天前/);
      if (dayMatch) return now - parseInt(dayMatch[1]) * 86400;
      // 11) "X周前"
      const weekMatch = t.match(/(\\d+)周前/);
      if (weekMatch) return now - parseInt(weekMatch[1]) * 604800;
      // 12) "X个月前"/"X月前"
      const monthMatch = t.match(/(\\d+)个?月前/);
      if (monthMatch) return now - parseInt(monthMatch[1]) * 2592000;
      // 13) "X年前"
      const yearMatch = t.match(/(\\d+)年前/);
      if (yearMatch) return now - parseInt(yearMatch[1]) * 31536000;
      // 14) "M月D日 HH:MM"
      const mdhmMatch = t.match(/(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2}):(\\d{2})/);
      if (mdhmMatch) {
        const d = new Date(thisYear, parseInt(mdhmMatch[1])-1, parseInt(mdhmMatch[2]), parseInt(mdhmMatch[3]), parseInt(mdhmMatch[4]));
        if (d.getTime() > Date.now()) d.setFullYear(thisYear - 1);
        return Math.floor(d.getTime()/1000);
      }
      // 15) "M月D日"
      const mdMatch = t.match(/(\\d{1,2})月(\\d{1,2})日/);
      if (mdMatch) {
        const d = new Date(thisYear, parseInt(mdMatch[1])-1, parseInt(mdMatch[2]));
        if (d.getTime() > Date.now()) d.setFullYear(thisYear - 1);
        return Math.floor(d.getTime()/1000);
      }
      // 16) "YYYY-MM-DD HH:MM" 或 "YYYY/MM/DD HH:MM"
      const ymdhmMatch = t.match(/(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})\\s*(\\d{1,2}):(\\d{2})/);
      if (ymdhmMatch) return Math.floor(new Date(parseInt(ymdhmMatch[1]), parseInt(ymdhmMatch[2])-1, parseInt(ymdhmMatch[3]), parseInt(ymdhmMatch[4]), parseInt(ymdhmMatch[5])).getTime()/1000);
      // 17) "YYYY-MM-DD" 或 "YYYY/MM/DD"
      const ymdMatch = t.match(/(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})/);
      if (ymdMatch) return Math.floor(new Date(parseInt(ymdMatch[1]), parseInt(ymdMatch[2])-1, parseInt(ymdMatch[3])).getTime()/1000);
      // 18) "MM-DD HH:MM" 或 "MM/DD HH:MM"
      const mdhm2Match = t.match(/(\\d{1,2})[-\\/](\\d{1,2})\\s+(\\d{1,2}):(\\d{2})/);
      if (mdhm2Match) {
        const d = new Date(thisYear, parseInt(mdhm2Match[1])-1, parseInt(mdhm2Match[2]), parseInt(mdhm2Match[3]), parseInt(mdhm2Match[4]));
        if (d.getTime() > Date.now()) d.setFullYear(thisYear - 1);
        return Math.floor(d.getTime()/1000);
      }
      // 19) "MM-DD" 或 "MM/DD"
      const md2Match = t.match(/^(\\d{1,2})[-\\/](\\d{1,2})$/);
      if (md2Match) {
        const d = new Date(thisYear, parseInt(md2Match[1])-1, parseInt(md2Match[2]));
        if (d.getTime() > Date.now()) d.setFullYear(thisYear - 1);
        return Math.floor(d.getTime()/1000);
      }
      // 20) 纯时间 "HH:MM"（当天的评论，XHS 常见格式）
      const hmOnlyMatch = t.match(/^(\\d{1,2}):(\\d{2})$/);
      if (hmOnlyMatch) {
        const d = new Date(); d.setHours(parseInt(hmOnlyMatch[1]), parseInt(hmOnlyMatch[2]), 0, 0);
        // 如果计算出的时间在未来（超过当前时间5分钟），则可能是昨天的
        if (d.getTime() > Date.now() + 5 * 60 * 1000) {
          d.setTime(d.getTime() - 86400 * 1000);
        }
        return Math.floor(d.getTime()/1000);
      }
      return 0;
    }
  })()`;
  return (await execJS(view.webContents, script)) || [];
}

async function scrollCommentPanel(view, times = 12, deltaY = 150) {
  const wc = view.webContents;
  for (let i = 0; i < times; i++) {
    await execJS(wc, `(function(){
      // 优先找笔记详情弹窗中的滚动容器
      var scroller = document.querySelector('.note-scroller');
      if (scroller) { scroller.scrollBy(0, ${deltaY}); return; }
      // 笔记详情弹窗内的滚动区域
      var detailContainer = document.querySelector('.note-detail-mask .note-container, .note-detail-mask, [class*="note-detail"]');
      if (detailContainer) {
        var scrollEl = detailContainer.querySelector('[class*="scroll"], [class*="list"]');
        if (scrollEl) { scrollEl.scrollBy(0, ${deltaY}); return; }
      }
      // 评论区容器
      scroller = document.querySelector('.comments-el, [class*="comment-list"]');
      if (scroller) { scroller.scrollBy(0, ${deltaY}); return; }
      // 降级：找任何可滚动的评论相关容器
      var list = document.querySelector('[class*="comment"]');
      if (list) {
        var p = list;
        while (p) {
          var s = getComputedStyle(p);
          if (s.overflowY === 'auto' || s.overflowY === 'scroll') {
            p.scrollBy(0, ${deltaY});
            return;
          }
          p = p.parentElement;
        }
      }
      // 最后降级：滚动整个页面
      window.scrollBy(0, ${deltaY});
    })()`);
    await sleep(1000, 2000);
  }
}

// ========== 验证码相关 ==========

async function hasCaptcha(view) {
  return await execJS(view.webContents, `(function(){
    if (document.querySelector('.geetest_panel, .captcha-container, [class*="geetest"]')) return true;
    const t = document.body.innerText;
    return t.includes('请完成验证') || t.includes('拖动滑块') || t.includes('人机验证');
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
  return pos;
}

// ========== 搜索增强辅助函数 (JS注入确保React感知) ==========

// 聚焦搜索框并清空
async function focusAndClearSearch(view) {
  const wc = view.webContents;
  return await execJS(wc, "(function(){var cs=document.querySelectorAll('textarea, input');var t=null;for(var i=0;i<cs.length;i++){var r=cs[i].getBoundingClientRect();if(r.width>50&&r.height>10){t=cs[i];break;}}if(!t)return false;try{t.focus();t.value='';t.dispatchEvent(new Event('input',{bubbles:true}));}catch(e){return false;}return true;})()");
}

// 用 value setter 设置搜索关键词（让 React 等框架能感知变化） 
async function setKeywordWithSetter(view, keyword) {
  const wc = view.webContents;
  // 将 keyword 安全转义为 JS 字符串字面量
  const safeKw = keyword
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '')
    .replace(/\r/g, '');
  const script = "(function(){var cs=document.querySelectorAll('textarea, input');var t=null;for(var i=0;i<cs.length;i++){var r=cs[i].getBoundingClientRect();if(r.width>50&&r.height>10){t=cs[i];break;}}if(!t)return false;try{t.focus();}catch(e){}var kw=\"" + safeKw + "\";try{var proto=t.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(t,kw);}catch(e){t.value=kw;}try{t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));}catch(e){}return true;})()";
  try {
    const r = await execJS(wc, script);
    return r === true || r === 'true';
  } catch (e) { return false; }
}

// 通过JS在页面中分发键盘事件（相比 webContents.sendInputEvent 对框架更可靠）
async function sendEnterKey(view) {
  const wc = view.webContents;
  return await execJS(wc, "(function(){var cs=document.querySelectorAll('textarea, input');var t=null;for(var i=0;i<cs.length;i++){var r=cs[i].getBoundingClientRect();if(r.width>50&&r.height>10){t=cs[i];break;}}if(!t)t=document.body;try{t.focus();}catch(e){}var opts={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};var ok=false;try{t.dispatchEvent(new KeyboardEvent('keydown',opts));ok=true;}catch(e){}try{t.dispatchEvent(new KeyboardEvent('keypress',opts));ok=true;}catch(e){}try{t.dispatchEvent(new KeyboardEvent('keyup',opts));ok=true;}catch(e){}return ok;})()");
}

// 直接触发搜索导航（终极 fallback），返回新 URL
async function loadSearchURL(view, keyword) {
  const wc = view.webContents;
  const url = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(keyword) + '&source=web_explore_feed';
  await wc.loadURL(url);
  return true;
}

 module.exports = {
   execJS, sleep, waitForElement,
   findSearchInput, findSearchButton, setSearchInputValue,
   clickNoteById, scanNoteLinks,
   getCommentCount, readDomComments, scrollCommentPanel,
   hasCaptcha, clickByText,
   focusAndClearSearch, setKeywordWithSetter, sendEnterKey, loadSearchURL
 };
