/**
 * 共享 DOM 操作工具
 * 抽离自 search.js / monitor.js 重复的 DOM 采集代码
 *
 * 包含：
 *   - scanVideoLinks   扫描页面视频列表
 *   - scanBloggerVideos 扫描博主主页视频列表
 *   - clickVideoById   根据 aweme_id 定位并点击
 *   - readDomComments  从 DOM 兜底采集评论
 *   - clickByText      按文本定位并点击
 *   - getCommentCount  读取评论数（抢首评=0 / 数字=有评论 / -1=未知）
 *   - hasCommentPanel  检测评论区是否出现
 *   - scrollCommentPanel 滚动评论区加载更多
 */

const human = require('./humanBehavior');
const { getLogger } = require('./logger');

const logger = getLogger('DomUtils');

/**
 * 通用：在 WebContents 中执行 JS 并容错
 */
async function execJS(wc, script) {
  try {
    return await wc.executeJavaScript(script);
  } catch (e) {
    return null;
  }
}

/**
 * 扫描页面上的视频链接
 * @param {BrowserView} view
 * @returns {Promise<Array<{aid:string}>>}
 */
async function scanVideoLinks(view) {
  return (await execJS(view.webContents, `
    (function(){
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
    })()
  `)) || [];
}

/**
 * 扫描博主主页视频列表（结构上与搜索结果相同，保留独立 API 便于以后扩展）
 */
async function scanBloggerVideos(view) {
  return scanVideoLinks(view);
}

/**
 * 根据 aweme_id 定位页面上的视频并点击
 * @returns {Promise<boolean>} 是否成功
 */
async function clickVideoById(view, aid) {
  const wc = view.webContents;
  const pos = await execJS(wc, `
    (function() {
      const links = document.querySelectorAll('a[href*="/video/${aid}"]');
      for (const a of links) {
        a.scrollIntoView({ block: 'center' });
        const r = a.getBoundingClientRect();
        if (r.width > 50 && r.height > 50)
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
      return null;
    })()
  `);
  if (!pos) return false;
  await sleep(500, 1000);
  await human.mouseClick(wc, pos.x, pos.y);
  return true;
}

/**
 * 从 DOM 兜底采集评论
 * 注意：DOM 采集丢失部分字段（IP属地、create_time、sec_uid、uid）
 * 完整字段依赖 CDP 拦截
 */
async function readDomComments(view) {
  return (await execJS(view.webContents, `
    (function() {
      const result = [];
      const seen = new Set();
      const SKIP = new Set(['回复','分享','作者赞过','收起','展开','举报','复制','删除','赞','踩','抢沙发','添加表情','查看更多回复','查看全部回复','更多回复']);
      const items = document.querySelectorAll('[data-e2e="comment-list"] > div > div, [class*="comment-item"], [class*="CommentItem"]');
      for (const item of items) {
        let best = '';
        let nick = '';
        for (const el of item.querySelectorAll('p, span, div')) {
          const t = (el.innerText || '').trim();
          if (!t || t.length < 3 || t.length > 500 || SKIP.has(t)) continue;
          if (/^\\d+$/.test(t) || /^[\\d\\.]+万?$/.test(t)) continue;
          if (t.length > best.length) best = t;
        }
        if (!best || best.length < 4 || seen.has(best)) continue;
        seen.add(best);
        const ne = item.querySelector('a[href*="/user/"]');
        if (ne) {
          const nt = (ne.innerText || '').trim();
          if (nt.length > 0 && nt.length < 30 && !SKIP.has(nt)) nick = nt;
        }
        result.push({
          text: best,
          nickname: nick,
          comment_id: 'dom_' + Math.random().toString(36).substr(2, 9),
          create_time: 0,
          ip_label: '',
          source: 'dom'
        });
      }
      return result;
    })()
  `)) || [];
}

/**
 * 按文本精确匹配元素并点击
 */
async function clickByText(view, text) {
  const wc = view.webContents;
  const pos = await execJS(wc, `
    (function(){
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText||'').trim();
        if (t === '${escapeForTemplate(text)}') {
          const r = el.getBoundingClientRect();
          if (r.width>10 && r.height>10 && r.height<50 && r.y<200 && r.y>30)
            return { x:r.x+r.width/2, y:r.y+r.height/2 };
        }
      }
      return null;
    })()
  `);
  if (pos) await human.mouseClick(wc, pos.x, pos.y);
  return !!pos;
}

/**
 * 检测评论区是否出现
 */
async function hasCommentPanel(view) {
  return !!(await execJS(view.webContents, `
    !!document.querySelector('[data-e2e="comment-list"], [class*="comment-list"], [class*="CommentList"]')
  `));
}

/**
 * 获取评论数
 * @returns {Promise<number>} 0=抢首评无评论, -1=未知, 其他=评论数
 */
async function getCommentCount(view) {
  return (await execJS(view.webContents, `
    (function(){
      const body = document.body.innerText;
      if (body.includes('抢首评')) return 0;
      const commentBtn = document.querySelector('[data-e2e="comment-icon"], [class*="comment-count"], [class*="CommentCount"]');
      if (commentBtn) {
        const text = commentBtn.innerText || '';
        const m = text.match(/(\\d+)/);
        if (m) return parseInt(m[1]);
      }
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.match(/^\\d+$/) && el.nextElementSibling && (el.nextElementSibling.innerText||'').includes('评')) {
          return parseInt(t);
        }
      }
      return -1;
    })()
  `)) ?? -1;
}

/**
 * 滚动评论区加载更多
 * @param {number} times 滚动次数
 * @param {number} deltaY 每次滚动像素
 */
async function scrollCommentPanel(view, times = 12, deltaY = 150) {
  const wc = view.webContents;
  for (let i = 0; i < times; i++) {
    await execJS(wc, `
      (function(){
        const panel = document.querySelector('[data-e2e="comment-list"], [class*="comment-list"], [class*="CommentList"]');
        if (panel) panel.scrollBy(0, ${deltaY});
        else {
          const comment = document.querySelector('[class*="comment"]');
          if (comment) {
            const p = comment.closest('[style*="overflow"]') || comment.parentElement;
            if (p) p.scrollBy(0, ${deltaY});
          }
        }
      })()
    `);
    await sleep(1000, 2000);
  }
}

/**
 * 通过 JS 设置并读取 input 元素的值
 */
async function readInputValue(view, selector) {
  return await execJS(view.webContents, `
    (function(){
      const e = document.querySelector('${selector}');
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, val: e.value || '' };
    })()
  `);
}

/**
 * 模板字符串转义：防止关键词中含单引号导致模板内嵌脚本报错
 */
function escapeForTemplate(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  execJS,
  scanVideoLinks,
  scanBloggerVideos,
  clickVideoById,
  readDomComments,
  clickByText,
  hasCommentPanel,
  getCommentCount,
  scrollCommentPanel,
  readInputValue
};
