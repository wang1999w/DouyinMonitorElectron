/**
 * 搜索引擎模块
 * 从 Python core/search_engine.py 迁移
 * 全部使用鼠标模拟和键盘模拟，不使用 loadURL 跳转，降低风控
 */

const { getDouyinView } = require('../main/window');
const { matchIntent, calcCommentScore } = require('./match');
const database = require('./database');
const notifier = require('./notifier');
const { getLogger } = require('./logger');

const logger = getLogger('SearchEngine');

let searchRunning = false;
let searchPaused = false;
let logCallback = null;

async function startSearch(params, onLog, onResult) {
  if (searchRunning) return;
  searchRunning = true;
  searchPaused = false;
  logCallback = onLog;

  log('搜索任务启动...');

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) {
      log('浏览器未就绪');
      searchRunning = false;
      return;
    }

    await ensureLogin(view);

    const keywords = params.keywords || [];
    let totalComments = 0;
    let totalMatched = 0;

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!searchRunning) break;

      const kw = keywords[kwIdx];
      log(`[${kwIdx + 1}/${keywords.length}] 搜索关键词: ${kw}`);

      // 模拟键盘输入搜索关键词并回车
      await typeAndSearch(view, kw);
      await sleep(5000, 7000);

      // 模拟点击视频标签
      await clickByText(view, '视频');
      await sleep(2000, 3000);

      // 扫描视频列表
      const videos = await scanVideos(view);
      log(`发现 ${videos.length} 个视频`);

      const maxVideos = params.maxVideos || 10;
      const cutoffTs = Math.floor(Date.now() / 1000) - (params.commentHours || 60) * 60;

      for (let i = 0; i < Math.min(videos.length, maxVideos); i++) {
        if (!searchRunning) break;

        const video = videos[i];
        log(`[${i + 1}/${Math.min(videos.length, maxVideos)}] 处理视频 ${video.aid}`);

        // 模拟鼠标点击视频卡片（不使用 loadURL）
        const clicked = await clickVideoById(view, video.aid);
        if (!clicked) {
          log('  未定位到视频，跳过');
          continue;
        }
        await sleep(3000, 5000);

        const result = await processVideo(view, video.aid, params.maxComments || 200, cutoffTs, onResult);
        if (result) {
          totalComments += result.total;
          totalMatched += result.matched;
        }

        await sleep(5000, 15000);
      }
    }

    log(`搜索完成！共 ${totalComments} 条评论，${totalMatched} 条意向`);
  } catch (e) {
    log(`搜索异常: ${e.message}`);
  } finally {
    searchRunning = false;
    searchPaused = false;
  }
}

function stopSearch() {
  searchRunning = false;
  searchPaused = false;
  log('搜索已停止');
}

function pauseSearch() {
  searchPaused = !searchPaused;
  log(searchPaused ? '搜索已暂停' : '搜索已恢复');
}

async function ensureLogin(view) {
  try {
    const body = await view.webContents.executeJavaScript(
      'document.body.innerText.substring(0, 300)'
    );
    if (body.includes('登录') && body.length < 100) {
      log('请在浏览器中登录抖音...');
      for (let i = 0; i < 100; i++) {
        await sleep(3000);
        if (!searchRunning) return;
        const b = await view.webContents.executeJavaScript(
          'document.body.innerText.substring(0, 300)'
        );
        if (!b.includes('登录') || b.length > 100) {
          log('登录成功');
          break;
        }
      }
    }
  } catch (e) {}
}

/**
 * 模拟键盘输入搜索关键词并回车（不使用 loadURL）
 */
async function typeAndSearch(view, keyword) {
  try {
    // 先点击搜索框
    await view.webContents.executeJavaScript(`
      (function() {
        const input = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
        if (input) { input.focus(); input.click(); }
      })()
    `);
    await sleep(500, 1000);

    // 模拟键盘输入：全选 → 删除 → 逐字输入
    await sendKey(view, 'a', 'ctrl');
    await sleep(100, 200);
    await sendKey(view, 'Backspace');
    await sleep(200, 400);

    for (const ch of keyword) {
      if (!searchRunning) return;
      await sendChar(view, ch);
      await sleep(50, 150);
    }
    await sleep(500, 1000);

    // 模拟回车搜索
    await sendKey(view, 'Enter');
  } catch (e) {
    log(`输入搜索失败: ${e.message}`);
  }
}

/**
 * 模拟点击文本匹配的元素
 */
async function clickByText(view, text) {
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.innerText || '').trim();
          if (t === '${text}') {
            const r = el.getBoundingClientRect();
            if (r.width > 10 && r.height > 10 && r.height < 50 && r.y < 200) {
              el.click();
              return true;
            }
          }
        }
        return false;
      })()
    `);
  } catch (e) {}
}

/**
 * 模拟鼠标点击指定视频（通过坐标）
 */
async function clickVideoById(view, aid) {
  try {
    return await view.webContents.executeJavaScript(`
      (function() {
        const links = document.querySelectorAll('a[href*="/video/${aid}"]');
        for (const a of links) {
          const r = a.getBoundingClientRect();
          if (r.width > 50 && r.height > 50) {
            a.scrollIntoView({ block: 'center' });
            const evt = new MouseEvent('click', {
              bubbles: true, cancelable: true, view: window,
              clientX: r.x + r.width / 2, clientY: r.y + r.height / 2
            });
            a.dispatchEvent(evt);
            return true;
          }
        }
        return false;
      })()
    `);
  } catch (e) {
    return false;
  }
}

async function scanVideos(view) {
  try {
    return await view.webContents.executeJavaScript(`
      (function() {
        const links = document.querySelectorAll('a[href*="/video/"]');
        const result = [];
        const seen = new Set();
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\\/video\\/(\\d+)/);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          result.push({ aid: m[1] });
        }
        return result;
      })()
    `);
  } catch (e) {
    return [];
  }
}

async function processVideo(view, aid, maxComments, cutoffTs, onResult) {
  try {
    // 模拟按 x 打开评论区（键盘模拟）
    await sendChar(view, 'x');
    await sleep(3000, 4000);

    const comments = await scrollAndCollectComments(view, aid, maxComments, cutoffTs);
    log(`  收集到 ${comments.length} 条评论`);

    const cfg = require('./config').loadConfig();
    let matched = 0;

    for (const c of comments) {
      if (!searchRunning) break;

      const [ok, keywords, isGarbage] = matchIntent(
        c.text,
        cfg.search_intent_keywords || [],
        cfg.search_garbage_keywords || []
      );

      if (ok && !isGarbage) {
        matched++;
        c.aweme_id = aid;
        c.matched_keywords = keywords;
        c.video_url = `https://www.douyin.com/video/${aid}`;
        c.score = calcCommentScore(c.create_time);

        database.addIntentComment(c);

        const resultData = {
          nickname: c.nickname || '',
          douyin_id: c.short_id || '',
          comment_text: c.text,
          matched_keywords: keywords.join(','),
          comment_time: c.create_time
            ? new Date(c.create_time * 1000).toLocaleString('zh-CN')
            : '',
          video_author: '',
          score: c.score
        };

        if (onResult) onResult(resultData);
        notifier.notify(resultData);
        log(`    [命中] ${c.nickname}: ${c.text.slice(0, 30)} -> ${keywords.join(',')}`);
      }
    }

    // 模拟 ESC 退出（键盘模拟）
    await sendKey(view, 'Escape');
    await sleep(2000, 3000);

    return { total: comments.length, matched };
  } catch (e) {
    log(`  处理视频异常: ${e.message}`);
    try { await sendKey(view, 'Escape'); } catch (e2) {}
    return null;
  }
}

async function scrollAndCollectComments(view, aid, maxComments, cutoffTs) {
  const allComments = [];
  const seenIds = new Set();

  for (let scroll = 0; scroll < 20; scroll++) {
    if (!searchRunning) break;

    const domComments = await view.webContents.executeJavaScript(`
      (function() {
        const result = [];
        const seen = new Set();
        const SKIP = new Set(['回复','分享','作者赞过','收起','展开','举报','复制','删除','赞','踩','抢沙发','添加表情']);
        const items = document.querySelectorAll(
          '[data-e2e="comment-list"] > div > div, [class*="comment-item"], [class*="CommentItem"]'
        );
        for (const item of items) {
          let best = '';
          let nick = '';
          const allEls = item.querySelectorAll('p, span, div');
          for (const el of allEls) {
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
          result.push({ text: best, nickname: nick, comment_id: 'dom_' + Math.random().toString(36).substr(2, 9) });
        }
        return result;
      })()
    `);

    for (const c of domComments) {
      if (c.text && !seenIds.has(c.text)) {
        seenIds.add(c.text);
        allComments.push(c);
      }
    }

    if (allComments.length >= maxComments) break;

    // 模拟鼠标滚动评论区
    await view.webContents.executeJavaScript(`
      (function() {
        const panel = document.querySelector('[data-e2e="comment-list"], [class*="comment-panel"]');
        if (panel) panel.scrollBy(0, 150);
        else window.scrollBy(0, 150);
      })()
    `);
    await sleep(1000, 2000);
  }

  return allComments;
}

/**
 * 模拟键盘按键（keydown + keyup）
 */
async function sendKey(view, key, modifier) {
  const mods = modifier ? [modifier] : [];
  await view.webContents.sendInputEvent({ type: 'keyDown', key, keyCode: key, modifiers: mods });
  await sleep(30, 80);
  await view.webContents.sendInputEvent({ type: 'keyUp', key, keyCode: key, modifiers: mods });
  await sleep(30, 80);
}

/**
 * 模拟字符输入
 */
async function sendChar(view, char) {
  await view.webContents.sendInputEvent({ type: 'char', char });
  await sleep(10, 30);
}

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startSearch, stopSearch, pauseSearch };
