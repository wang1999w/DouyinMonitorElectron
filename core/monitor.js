/**
 * 博主监控引擎
 * 每个博主独立配置意向/垃圾关键词
 * 支持调度器通过 executeSingleBlogger 调用
 * 全部使用鼠标/键盘模拟
 */

const { getDouyinView } = require('../main/window');
const { matchIntent, calcCommentScore } = require('./match');
const database = require('./database');
const config = require('./config');
const notifier = require('./notifier');
const { getLogger } = require('./logger');

const logger = getLogger('MonitorEngine');

let monitorRunning = false;
let logCallback = null;

function startMonitor(onLog) {
  if (monitorRunning) return;
  monitorRunning = true;
  logCallback = onLog;
  log('监控已启动（手动模式）');
}

function stopMonitor() {
  monitorRunning = false;
  log('监控已停止');
}

/**
 * 执行单个博主的监控（由调度器调用）
 * @param {Object} blogger - 博主配置（含独立的 intent/garbage keywords）
 * @param {Object} cfg - 全局配置
 * @param {Function} onLog - 日志回调
 */
async function executeSingleBlogger(blogger, cfg, onLog) {
  const savedCb = logCallback;
  if (onLog) logCallback = onLog;

  const nickname = blogger.nickname || '未知博主';
  const secUid = blogger.sec_uid || '';

  log(`监控博主: ${nickname}`);

  const view = getDouyinView();
  if (!view || !view.webContents) { log('浏览器未就绪'); return; }

  try {
    // 通过地址栏导航（键盘模拟）
    await navigateByUrl(view, `https://www.douyin.com/user/${secUid}`);
    await sleep(3000, 5000);

    // 滚动获取视频列表
    for (let i = 0; i < 5; i++) {
      await view.webContents.executeJavaScript('window.scrollBy(0, 400)');
      await sleep(1000, 2000);
    }

    const videos = await scanBloggerVideos(view);
    log(`  发现 ${videos.length} 个视频`);

    const cutoffTs = Math.floor(Date.now() / 1000) - 24 * 3600;

    for (const video of videos) {
      if (!monitorRunning) break;
      await processVideoComments(view, video.aid, blogger, cutoffTs);
    }

    log(`博主 ${nickname} 监控完成`);
  } catch (e) {
    log(`监控博主异常: ${e.message}`);
  } finally {
    logCallback = savedCb;
  }
}

/**
 * 通过地址栏导航（键盘模拟：Ctrl+L → 输入 URL → 回车）
 */
async function navigateByUrl(view, url) {
  try {
    await sendKey(view, 'l', ['ctrl']);
    await sleep(200, 400);
    await sendKey(view, 'a', ['ctrl']);
    await sleep(50, 100);
    await sendKey(view, 'Backspace');
    await sleep(100, 200);
    for (const ch of url) {
      await sendChar(view, ch);
      await sleep(10, 25);
    }
    await sleep(200, 400);
    await sendKey(view, 'Enter');
  } catch (e) { log(`导航失败: ${e.message}`); }
}

async function scanBloggerVideos(view) {
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
  } catch (e) { return []; }
}

async function processVideoComments(view, aid, blogger, cutoffTs) {
  try {
    const clicked = await view.webContents.executeJavaScript(`
      (function() {
        const links = document.querySelectorAll('a[href*="/video/${aid}"]');
        for (const a of links) {
          const r = a.getBoundingClientRect();
          if (r.width > 50 && r.height > 50) {
            a.scrollIntoView({ block: 'center' });
            a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2 }));
            return true;
          }
        }
        return false;
      })()
    `);
    if (!clicked) return;
    await sleep(3000, 5000);

    await sendChar(view, 'x');
    await sleep(2000, 3000);

    for (let scroll = 0; scroll < 20; scroll++) {
      await view.webContents.executeJavaScript(`(function(){ const p=document.querySelector('[data-e2e="comment-list"],[class*="comment-panel"]'); if(p) p.scrollBy(0,150); })()`);
      await sleep(500, 1000);
    }

    const comments = await view.webContents.executeJavaScript(`
      (function() {
        const result = [];
        const seen = new Set();
        const SKIP = new Set(['回复','分享','作者赞过','收起','展开','举报','复制','删除','赞','踩','抢沙发','添加表情']);
        const items = document.querySelectorAll('[data-e2e="comment-list"] > div > div, [class*="comment-item"], [class*="CommentItem"]');
        for (const item of items) {
          let best = '';
          let nick = '';
          for (const el of item.querySelectorAll('p, span, div')) {
            const t = (el.innerText || '').trim();
            if (!t || t.length < 3 || t.length > 500 || SKIP.has(t)) continue;
            if (t.length > best.length) best = t;
          }
          if (!best || best.length < 4 || seen.has(best)) continue;
          seen.add(best);
          const ne = item.querySelector('a[href*="/user/"]');
          if (ne) { const nt = (ne.innerText || '').trim(); if (nt.length > 0 && nt.length < 30 && !SKIP.has(nt)) nick = nt; }
          result.push({ text: best, nickname: nick, comment_id: 'mon_' + Math.random().toString(36).substr(2, 9), create_time: Math.floor(Date.now() / 1000) });
        }
        return result;
      })()
    `);

    // 使用博主独立的关键词进行匹配
    const intentKw = blogger.intent_keywords || [];
    const garbageKw = blogger.garbage_keywords || [];

    for (const c of comments) {
      const [ok, keywords, isGarbage] = matchIntent(c.text, intentKw, garbageKw);
      if (ok && !isGarbage) {
        c.aweme_id = aid;
        c.matched_keywords = keywords;
        c.video_url = `https://www.douyin.com/video/${aid}`;
        c.score = calcCommentScore(c.create_time);
        c.video_author = blogger.nickname || '';
        database.addIntentComment(c);
        const resultData = { nickname: c.nickname || '', comment_text: c.text, matched_keywords: keywords.join(','), video_author: blogger.nickname || '', score: c.score };
        notifier.notify(resultData);
        log(`    [命中] ${c.nickname}: ${c.text.slice(0, 30)} -> ${keywords.join(',')}`);
      }
    }

    await sendKey(view, 'Escape');
    await sleep(1000, 2000);
  } catch (e) {
    log(`  处理视频异常: ${e.message}`);
  }
}

async function sendKey(view, key, modifiers) {
  const mods = modifiers || [];
  await view.webContents.sendInputEvent({ type: 'keyDown', key, keyCode: key, modifiers: mods });
  await sleep(30, 60);
  await view.webContents.sendInputEvent({ type: 'keyUp', key, keyCode: key, modifiers: mods });
  await sleep(30, 60);
}

async function sendChar(view, char) {
  await view.webContents.sendInputEvent({ type: 'char', char });
  await sleep(8, 20);
}

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startMonitor, stopMonitor, executeSingleBlogger };
