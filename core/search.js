/**
 * 搜索引擎模块
 * 从 Python core/search_engine.py 迁移
 * 通过 BrowserView 导航到抖音搜索页，注入 JS 模拟操作
 * 拦截搜索结果 API，提取视频和评论数据进行意向匹配
 */

const { getDouyinView } = require('../main/window');
const { matchIntent, calcCommentScore } = require('./match');
const database = require('./database');
const notifier = require('./notifier');
const { getLogger } = require('./logger');
const { classifyUrl, extractAwemeId } = require('./interceptor');

const logger = getLogger('SearchEngine');

/** 搜索状态 */
let searchRunning = false;
let searchPaused = false;
let searchCallback = null;
let logCallback = null;

/**
 * 启动搜索
 * @param {Object} params - 搜索参数
 * @param {Function} onLog - 日志回调
 * @param {Function} onResult - 结果回调
 */
async function startSearch(params, onLog, onResult) {
  if (searchRunning) return;

  searchRunning = true;
  searchPaused = false;
  logCallback = onLog;
  searchCallback = onResult;

  log('搜索任务启动...');

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) {
      log('浏览器未就绪');
      searchRunning = false;
      return;
    }

    // 检查登录状态
    await ensureLogin(view);

    const keywords = params.keywords || [];
    let totalComments = 0;
    let totalMatched = 0;

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!searchRunning) break;

      const kw = keywords[kwIdx];
      log(`[${kwIdx + 1}/${keywords.length}] 搜索关键词: ${kw}`);

      // 导航到搜索页
      await navigateToSearch(view, kw);
      await sleep(3000, 5000);

      // 切换到视频标签
      await switchToVideoTab(view);
      await sleep(2000, 3000);

      // 扫描视频列表
      const videos = await scanVideos(view);
      log(`发现 ${videos.length} 个视频`);

      // 处理每个视频
      const maxVideos = params.maxVideos || 10;
      const cutoffTs = Math.floor(Date.now() / 1000) - (params.commentHours || 60) * 60;

      for (let i = 0; i < Math.min(videos.length, maxVideos); i++) {
        if (!searchRunning) break;

        const video = videos[i];
        log(`[${i + 1}/${Math.min(videos.length, maxVideos)}] 处理视频 ${video.aid}`);

        const result = await processVideo(view, video.aid, params.maxComments || 200, cutoffTs, onResult);
        if (result) {
          totalComments += result.total;
          totalMatched += result.matched;
        }

        // 随机暂停模拟浏览
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

/**
 * 停止搜索
 */
function stopSearch() {
  searchRunning = false;
  searchPaused = false;
  log('搜索已停止');
}

/**
 * 暂停/恢复搜索
 */
function pauseSearch() {
  searchPaused = !searchPaused;
  log(searchPaused ? '搜索已暂停' : '搜索已恢复');
}

/**
 * 确保已登录抖音
 */
async function ensureLogin(view) {
  try {
    const body = await view.webContents.executeJavaScript(
      'document.body.innerText.substring(0, 300)'
    );
    if (body.includes('登录') && body.length < 100) {
      log('请在浏览器中登录抖音...');
      // 等待用户登录（最多 5 分钟）
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
 * 导航到搜索页
 */
async function navigateToSearch(view, keyword) {
  try {
    const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`;
    await view.webContents.loadURL(url);
  } catch (e) {
    log(`导航失败: ${e.message}`);
  }
}

/**
 * 切换到视频标签
 */
async function switchToVideoTab(view) {
  try {
    await view.webContents.executeJavaScript(`
      (function() {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.innerText || '').trim();
          if (t === '视频') {
            const r = el.getBoundingClientRect();
            if (r.width > 10 && r.height > 10 && r.height < 50 && r.y < 150) {
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
 * 扫描页面上的视频列表
 * @returns {Array<{aid: string}>} 视频 ID 列表
 */
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

/**
 * 处理单个视频：打开、滚动评论、提取评论、匹配意向
 */
async function processVideo(view, aid, maxComments, cutoffTs, onResult) {
  try {
    // 导航到视频页
    await view.webContents.loadURL(`https://www.douyin.com/video/${aid}`);
    await sleep(3000, 5000);

    // 打开评论区
    await view.webContents.sendInputEvent('char', { text: 'x' });
    await sleep(3000, 4000);

    // 滚动加载评论
    const comments = await scrollAndCollectComments(view, aid, maxComments, cutoffTs);
    log(`  收集到 ${comments.length} 条评论`);

    // 匹配意向关键词
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

        // 异步发送通知
        notifier.notify(resultData);

        log(`    [命中] ${c.nickname}: ${c.text.slice(0, 30)} -> ${keywords.join(',')}`);
      }
    }

    // ESC 退出视频
    await view.webContents.sendInputEvent('key', { keyCode: 'Escape', code: 'Escape', key: 'Escape' });
    await sleep(2000, 3000);

    return { total: comments.length, matched };
  } catch (e) {
    log(`  处理视频异常: ${e.message}`);
    try {
      await view.webContents.sendInputEvent('key', { keyCode: 'Escape', code: 'Escape', key: 'Escape' });
    } catch (e2) {}
    return null;
  }
}

/**
 * 滚动加载并收集评论
 */
async function scrollAndCollectComments(view, aid, maxComments, cutoffTs) {
  const allComments = [];
  const seenIds = new Set();

  for (let scroll = 0; scroll < 20; scroll++) {
    if (!searchRunning) break;

    // 从 DOM 读取评论
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

    // 滚动评论区
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
 * 输出日志
 */
function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startSearch, stopSearch, pauseSearch };
