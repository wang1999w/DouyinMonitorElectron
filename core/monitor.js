/**
 * 博主监控引擎
 * 从 Python core/monitor_engine.py 迁移
 * 定时检查配置的博主，采集其新视频评论并匹配意向
 */

const { getDouyinView } = require('../main/window');
const { matchIntent, calcCommentScore } = require('./match');
const database = require('./database');
const config = require('./config');
const notifier = require('./notifier');
const { getLogger } = require('./logger');

const logger = getLogger('MonitorEngine');

/** 监控状态 */
let monitorRunning = false;
let monitorTimer = null;
let logCallback = null;

/**
 * 启动监控
 * @param {Function} onLog - 日志回调
 */
function startMonitor(onLog) {
  if (monitorRunning) return;

  monitorRunning = true;
  logCallback = onLog;
  log('监控已启动');

  // 立即执行一次检查
  runCheck();

  // 每 60 秒检查一次
  monitorTimer = setInterval(() => {
    if (monitorRunning) runCheck();
  }, 60000);
}

/**
 * 停止监控
 */
function stopMonitor() {
  monitorRunning = false;
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  log('监控已停止');
}

/**
 * 执行一次监控检查
 */
async function runCheck() {
  try {
    const cfg = config.loadConfig();
    const bloggers = (cfg.monitor_bloggers || []).filter(b => b.status === 1);

    if (bloggers.length === 0) {
      log('无活跃监控博主，等待...');
      return;
    }

    for (const blogger of bloggers) {
      if (!monitorRunning) break;
      await processBlogger(blogger, cfg);
    }

    log('本轮监控完成');
  } catch (e) {
    log(`监控异常: ${e.message}`);
  }
}

/**
 * 处理单个博主的监控
 * @param {Object} blogger - 博主配置
 * @param {Object} cfg - 全局配置
 */
async function processBlogger(blogger, cfg) {
  const nickname = blogger.nickname || '未知博主';
  const secUid = blogger.sec_uid || '';

  // 检查是否在监控时段内
  if (!isInSchedule(blogger.time_ranges || [])) {
    return;
  }

  log(`监控博主: ${nickname}`);

  const view = getDouyinView();
  if (!view || !view.webContents) {
    log('浏览器未就绪');
    return;
  }

  try {
    // 导航到博主主页
    await view.webContents.loadURL(`https://www.douyin.com/user/${secUid}`);
    await sleep(3000, 5000);

    // 滚动获取视频列表
    const videos = await scanBloggerVideos(view);
    log(`  发现 ${videos.length} 个视频`);

    const cutoffTs = Math.floor(Date.now() / 1000) - 24 * 3600;

    for (const video of videos) {
      if (!monitorRunning) break;

      await processVideoComments(view, video.aid, cfg, nickname, cutoffTs);
    }

    log(`博主 ${nickname} 监控完成`);
  } catch (e) {
    log(`监控博主异常: ${e.message}`);
  }
}

/**
 * 检查当前时间是否在监控时段内
 * @param {Array<string>} timeRanges - 时间段数组 ["09:00-09:40", ...]
 * @returns {boolean}
 */
function isInSchedule(timeRanges) {
  if (!timeRanges || timeRanges.length === 0) return true;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const tr of timeRanges) {
    try {
      const [start, end] = tr.split('-');
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      if (nowMinutes >= startMin && nowMinutes <= endMin) {
        return true;
      }
    } catch (e) {
      continue;
    }
  }

  return false;
}

/**
 * 扫描博主主页的视频列表
 */
async function scanBloggerVideos(view) {
  // 滚动几次加载更多视频
  for (let i = 0; i < 5; i++) {
    if (!monitorRunning) break;
    await view.webContents.executeJavaScript('window.scrollBy(0, 400)');
    await sleep(1000, 2000);
  }

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

/**
 * 处理视频评论（监控模式）
 */
async function processVideoComments(view, aid, cfg, bloggerNickname, cutoffTs) {
  try {
    await view.webContents.loadURL(`https://www.douyin.com/video/${aid}`);
    await sleep(3000, 5000);

    // 打开评论区
    await view.webContents.sendInputEvent('char', { text: 'x' });
    await sleep(2000, 3000);

    // 滚动加载评论
    for (let scroll = 0; scroll < 20; scroll++) {
      if (!monitorRunning) break;

      await view.webContents.executeJavaScript(`
        (function() {
          const panel = document.querySelector('[data-e2e="comment-list"], [class*="comment-panel"]');
          if (panel) panel.scrollBy(0, 150);
        })()
      `);
      await sleep(500, 1000);
    }

    // 读取评论
    const comments = await view.webContents.executeJavaScript(`
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
            if (t.length > best.length) best = t;
          }
          if (!best || best.length < 4 || seen.has(best)) continue;
          seen.add(best);
          const ne = item.querySelector('a[href*="/user/"]');
          if (ne) {
            const nt = (ne.innerText || '').trim();
            if (nt.length > 0 && nt.length < 30 && !SKIP.has(nt)) nick = nt;
          }
          result.push({ text: best, nickname: nick, comment_id: 'mon_' + Math.random().toString(36).substr(2, 9), create_time: Math.floor(Date.now() / 1000) });
        }
        return result;
      })()
    `);

    // 匹配意向
    for (const c of comments) {
      if (!monitorRunning) break;

      const [ok, keywords, isGarbage] = matchIntent(
        c.text,
        cfg.monitor_intent_keywords || [],
        cfg.monitor_garbage_keywords || []
      );

      if (ok && !isGarbage) {
        c.aweme_id = aid;
        c.matched_keywords = keywords;
        c.video_url = `https://www.douyin.com/video/${aid}`;
        c.score = calcCommentScore(c.create_time);
        c.video_author = bloggerNickname;

        database.addIntentComment(c);

        const resultData = {
          nickname: c.nickname || '',
          comment_text: c.text,
          matched_keywords: keywords.join(','),
          video_author: bloggerNickname,
          score: c.score
        };

        notifier.notify(resultData);
        log(`    [命中] ${c.nickname}: ${c.text.slice(0, 30)} -> ${keywords.join(',')}`);
      }
    }

    // ESC 退出
    await view.webContents.sendInputEvent('key', { keyCode: 'Escape', code: 'Escape', key: 'Escape' });
    await sleep(1000, 2000);
  } catch (e) {
    log(`  处理视频异常: ${e.message}`);
  }
}

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startMonitor, stopMonitor };
