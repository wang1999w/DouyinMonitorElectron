/**
 * 搜索引擎模块（重构版）
 *
 * 采集流程：
 *   1. 地址栏输入搜索页 URL → 回车（模拟真人导航）
 *   2. 模拟点击视频标签 → 扫描视频列表
 *   3. 逐个模拟点击视频 → 等待播放 → 滚动加载评论
 *   4. CDP 拦截 API 响应获取完整评论 JSON（用户ID/昵称/IP/时间）
 *   5. DOM 采集补充 CDP 漏掉的数据
 *   6. pipeline.js 合并 → 匹配 → 评分 → 入库 → 推送
 *
 * 所有操作：鼠标移动(贝塞尔曲线) + 键盘输入(逐字) + 滚动(分步)
 */

const { getDouyinView, getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const pipeline = require('./pipeline');
const database = require('./database');
const scheduler = require('./scheduler');
const { getLogger } = require('./logger');

const logger = getLogger('SearchEngine');

let searchRunning = false;
let logCallback = null;

// ========== 入口 ==========

async function startSearch(params, onLog, onResult) {
  if (searchRunning) return;
  searchRunning = true;
  logCallback = onLog;
  scheduler.registerSearch(params);

  log('搜索任务启动...');

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('浏览器未就绪'); searchRunning = false; return; }

    await ensureLogin(view);

    const keywords = params.keywords || [];
    const cdp = getCDPInterceptor();
    let totalComments = 0;
    let totalMatched = 0;

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const cutoffTs = Math.floor(Date.now() / 1000) - (params.commentHours || 60) * 60;

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!searchRunning || scheduler.shouldAbortSearch()) break;

      const kw = keywords[kwIdx];
      log(`[${kwIdx + 1}/${keywords.length}] 搜索关键词: ${kw}`);

      // 1. 导航到搜索页
      await navigateToSearch(view, kw);
      await sleep(5000, 7000);

      // 2. 模拟点击"视频"标签
      await clickByText(view, '视频');
      await sleep(2000, 3000);

      // 3. 扫描视频列表
      const videos = await scanVideos(view);
      log(`发现 ${videos.length} 个视频`);

      const maxVideos = params.maxVideos || 10;

      for (let i = 0; i < Math.min(videos.length, maxVideos); i++) {
        if (!searchRunning || scheduler.shouldAbortSearch()) break;

        const video = videos[i];
        log(`[${i + 1}/${Math.min(videos.length, maxVideos)}] 处理视频 ${video.aid}`);

        // 模拟点击视频卡片
        const clicked = await clickVideoById(view, video.aid);
        if (!clicked) { log('  未定位到视频，跳过'); continue; }
        await sleep(3000, 5000);

        // 4. 模拟观看 + 滚动加载评论
        const videoInfo = { aweme_id: video.aid, desc: '', author: '', video_url: `https://www.douyin.com/video/${video.aid}` };

        // 先等几秒模拟观看
        await human.mouseMove(view.webContents, rand(300, 700), rand(200, 400));
        await sleep(3000, 6000);

        // 打开评论区（模拟按 x）
        await human.keyPress(view.webContents, 'x');
        await sleep(3000, 4000);

        // 滚动加载评论（模拟真人浏览）
        const maxComments = params.maxComments || 200;
        const cdpComments = cdp ? cdp.getComments(video.aid) : [];
        let domComments = [];

        for (let scroll = 0; scroll < 20; scroll++) {
          if (!searchRunning) break;

          // DOM 采集当前可见评论
          domComments = await readDomComments(view);

          // 模拟鼠标滚动评论区
          await human.mouseScroll(view.webContents, 'down', 1);

          // 随机模拟浏览（偶尔移动鼠标）
          if (Math.random() < 0.3) {
            await human.mouseMove(view.webContents, rand(600, 900), rand(300, 600));
          }
          await sleep(1000, 2000);

          if (domComments.length >= maxComments) break;
        }

        // 5. 通过 pipeline 合并处理 CDP + DOM 数据
        let videoComments = cdp ? cdp.getComments(video.aid) : [];
        // 合并 DOM 评论（补充 CDP 没有的）
        const domOnly = domComments.filter(d => !videoComments.some(c => c.text === d.text));
        videoComments = [...videoComments, ...domOnly];

        // 从 CDP 获取视频信息
        if (cdp && cdp.currentVideo && cdp.currentVideo.aweme_id === video.aid) {
          videoInfo.desc = cdp.currentVideo.desc || '';
          videoInfo.author = cdp.currentVideo.author || '';
        }

        // 6. 逐条处理
        for (const c of videoComments) {
          if (!searchRunning) break;
          const result = pipeline.processComment(c, null, videoInfo, { intent: intentKw, garbage: garbageKw });
          if (result) {
            totalComments++;
            totalMatched++;
            if (onResult) onResult(result);
          }
        }

        log(`  CDP: ${cdpComments.length}条, DOM: ${domComments.length}条, 命中: ${totalMatched}条`);

        // 模拟 ESC 退出视频
        await human.keyPress(view.webContents, 'Escape');
        await sleep(2000, 3000);

        // 随机暂停模拟浏览
        await sleep(5000, 15000);
      }
    }

    log(`搜索完成！共 ${totalMatched} 条意向`);
  } catch (e) {
    log(`搜索异常: ${e.message}`);
  } finally {
    searchRunning = false;
    scheduler.notifySearchDone();
  }
}

function stopSearch() {
  searchRunning = false;
  log('搜索已停止');
}

function pauseSearch() {
  log('搜索已暂停（由监控任务触发）');
}

function isRunning() { return searchRunning; }

// ========== 页面操作 ==========

async function ensureLogin(view) {
  try {
    const body = await view.webContents.executeJavaScript('document.body.innerText.substring(0, 300)');
    if (body.includes('登录') && body.length < 100) {
      log('请在浏览器中登录抖音...');
      for (let i = 0; i < 100; i++) {
        await sleep(3000);
        if (!searchRunning) return;
        const b = await view.webContents.executeJavaScript('document.body.innerText.substring(0, 300)');
        if (!b.includes('登录') || b.length > 100) { log('登录成功'); break; }
      }
    }
  } catch (e) {}
}

/** 通过地址栏导航（模拟真人：Ctrl+L → 输入 → 回车） */
async function navigateToSearch(view, keyword) {
  const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`;
  const wc = view.webContents;

  await human.keyPress(wc, 'l', ['ctrl']);
  await sleep(200, 400);
  await human.keyPress(wc, 'a', ['ctrl']);
  await sleep(50, 100);
  await human.keyPress(wc, 'Backspace');
  await sleep(100, 200);
  await human.typeText(wc, url);
  await sleep(200, 400);
  await human.keyPress(wc, 'Enter');
}

/** 模拟点击文本元素 */
async function clickByText(view, text) {
  try {
    const pos = await view.webContents.executeJavaScript(`
      (function() {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.innerText || '').trim();
          if (t === '${text}') {
            const r = el.getBoundingClientRect();
            if (r.width > 10 && r.height > 10 && r.height < 50 && r.y < 200)
              return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()
    `);
    if (pos) await human.mouseClick(view.webContents, pos.x, pos.y);
  } catch (e) {}
}

/** 模拟鼠标点击视频卡片 */
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

/** 扫描页面视频列表 */
async function scanVideos(view) {
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

/** DOM 采集当前可见评论 */
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
          result.push({ text: best, nickname: nick, comment_id: 'dom_' + Math.random().toString(36).substr(2, 9) });
        }
        return result;
      })()
    `);
  } catch (e) { return []; }
}

// ========== 工具 ==========

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

module.exports = { startSearch, stopSearch, pauseSearch, isRunning };
