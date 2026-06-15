/**
 * 博主监控引擎（重构版）
 *
 * 采集流程：
 *   1. 地址栏输入博主主页 URL → 回车
 *   2. 滚动加载视频列表 → 模拟点击视频
 *   3. 等待播放 → 打开评论区 → 滚动加载评论
 *   4. CDP 拦截评论 API 获取完整 JSON
 *   5. DOM 采集补充
 *   6. 使用博主独立关键词匹配 → 评分 → 入库 → 推送
 *
 * 调度器触发时：暂停搜索 → 执行监控 → 回首页 → 恢复搜索
 */

const { getDouyinView, getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const pipeline = require('./pipeline');
const database = require('./database');
const config = require('./config');
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
 */
async function executeSingleBlogger(blogger, cfg, onLog) {
  const savedCb = logCallback;
  if (onLog) logCallback = onLog;

  const nickname = blogger.nickname || '未知博主';
  const secUid = blogger.sec_uid || '';
  log(`监控博主: ${nickname}`);

  const view = getDouyinView();
  if (!view || !view.webContents) { log('浏览器未就绪'); return; }

  const cdp = getCDPInterceptor();
  const wc = view.webContents;

  // 博主独立关键词
  const intentKw = blogger.intent_keywords || [];
  const garbageKw = blogger.garbage_keywords || [];

  try {
    // 1. 导航到博主主页
    await navigateByUrl(view, `https://www.douyin.com/user/${secUid}`);
    await sleep(3000, 5000);

    // 2. 滚动加载视频列表
    for (let i = 0; i < 5; i++) {
      if (!monitorRunning) break;
      await human.mouseScroll(wc, 'down', 1);
      await sleep(1000, 2000);
    }

    // 3. 扫描视频
    const videos = await scanBloggerVideos(view);
    log(`  发现 ${videos.length} 个视频`);

    const cutoffTs = Math.floor(Date.now() / 1000) - (blogger.comment_hours || 60) * 60;

    for (const video of videos) {
      if (!monitorRunning) break;

      log(`  处理视频 ${video.aid}`);

      // 模拟点击视频
      const clicked = await clickVideoById(view, video.aid);
      if (!clicked) { log('    未定位到视频，跳过'); continue; }
      await sleep(5000, 8000);

      // 模拟观看
      await human.mouseMove(wc, rand(300, 700), rand(200, 400));
      await sleep(3000, 6000);

      // 检查评论数：抢首评=无评论，跳过
      const commentCount = await wc.executeJavaScript(`
        (function(){
          const body = document.body.innerText;
          if (body.includes('抢首评')) return 0;
          for (const el of document.querySelectorAll('*')) {
            const t = (el.innerText || '').trim();
            if (t.match(/^\\d+$/) && el.nextElementSibling && (el.nextElementSibling.innerText||'').includes('评')) {
              return parseInt(t);
            }
          }
          return -1;
        })()
      `).catch(() => -1);

      if (commentCount === 0) {
        log('    无评论，跳过');
        await human.keyPress(wc, 'Escape');
        await sleep(1000, 2000);
        continue;
      }
      log(`    评论数: ${commentCount === -1 ? '未知' : commentCount}`);

      // 打开评论区
      await human.keyPress(wc, 'x');
      await sleep(4000, 6000);

      // 5. 滚动加载评论
      for (let scroll = 0; scroll < 15; scroll++) {
        if (!monitorRunning) break;
        await wc.executeJavaScript(`
          (function(){
            const panel = document.querySelector('[data-e2e="comment-list"], [class*="comment-list"]');
            if (panel) panel.scrollBy(0, 150);
          })()
        `).catch(() => {});
        await sleep(1000, 2000);
      }

      // 6. 采集评论（CDP + DOM）
      const cdpComments = cdp ? cdp.getComments(video.aid) : [];
      const domComments = await readDomComments(view);
      const domOnly = domComments.filter(d => !cdpComments.some(c => c.text === d.text));
      let allComments = [...cdpComments, ...domOnly];

      // 时效过滤
      if (cutoffTs > 0) {
        const before = allComments.length;
        allComments = allComments.filter(c => (c.create_time || 0) >= cutoffTs);
        if (before > allComments.length) log(`    时效过滤: 排除${before - allComments.length}条`);
      }

      // 获取视频信息
      const videoInfo = {
        aweme_id: video.aid,
        desc: (cdp && cdp.currentVideo && cdp.currentVideo.aweme_id === video.aid) ? cdp.currentVideo.desc : '',
        author: (cdp && cdp.currentVideo && cdp.currentVideo.aweme_id === video.aid) ? cdp.currentVideo.author : nickname,
        video_url: `https://www.douyin.com/video/${video.aid}`
      };

      // 7. 逐条匹配处理
      let matched = 0;
      for (const c of allComments) {
        if (!monitorRunning) break;
        const result = pipeline.processComment(c, null, videoInfo, { intent: intentKw, garbage: garbageKw });
        if (result) {
          matched++;
          if (logCallback) logCallback(`    [命中] ${result.nickname}: ${result.text.slice(0, 30)} -> ${result.matched_keywords.join(',')}`);
        }
      }

      log(`  CDP: ${cdpComments.length}条, DOM: ${domComments.length}条, 命中: ${matched}条`);

      // ESC 退出
      await human.keyPress(wc, 'Escape');
      await sleep(2000, 3000);
    }

    log(`博主 ${nickname} 监控完成`);
  } catch (e) {
    log(`监控博主异常: ${e.message}`);
  } finally {
    logCallback = savedCb;
  }
}

/** 通过地址栏导航（键盘模拟） */
async function navigateByUrl(view, url) {
  await view.webContents.loadURL(url);
}

async function scanBloggerVideos(view) {
  try {
    return await view.webContents.executeJavaScript(`
      (function() {
        const links = document.querySelectorAll('a[href*="/video/"]');
        const result = [];
        const seen = new Set();
        for (const a of links) {
          const m = (a.getAttribute('href') || '').match(/\\/video\\/(\\d+)/);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          result.push({ aid: m[1] });
        }
        return result;
      })()
    `);
  } catch (e) { return []; }
}

async function clickVideoById(view, aid) {
  try {
    const pos = await view.webContents.executeJavaScript(`
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
    await human.mouseClick(view.webContents, pos.x, pos.y);
    return true;
  } catch (e) { return false; }
}

async function readDomComments(view) {
  try {
    return await view.webContents.executeJavaScript(`
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
            if (/^\\d+$/.test(t) || /^[\\d\\.]+万?$/.test(t)) continue;
            if (t.length > best.length) best = t;
          }
          if (!best || best.length < 4 || seen.has(best)) continue;
          seen.add(best);
          const ne = item.querySelector('a[href*="/user/"]');
          if (ne) { const nt = (ne.innerText || '').trim(); if (nt.length > 0 && nt.length < 30 && !SKIP.has(nt)) nick = nt; }
          result.push({ text: best, nickname: nick, comment_id: 'mon_' + Math.random().toString(36).substr(2, 9) });
        }
        return result;
      })()
    `);
  } catch (e) { return []; }
}

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

module.exports = { startMonitor, stopMonitor, executeSingleBlogger };
