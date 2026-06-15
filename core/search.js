/**
 * 搜索引擎模块
 *
 * 两种执行模式：
 *   1. 数量模式（排序开启）：搜索 → 切换视频标签 → 筛选排序 → 采集指定数量视频
 *   2. 时间模式（排序关闭）：搜索 → 自然浏览 → 持续采集直到任务时间结束
 *
 * 自动化操作全部模拟真人：地址栏导航 + 鼠标点击 + 键盘输入
 * CDP 拦截 API 响应获取完整评论数据（用户ID/昵称/IP/时间）
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

  const isQuantityMode = params.sortEnabled; // 排序开启 = 数量模式
  log(`搜索任务启动 [${isQuantityMode ? '数量模式' : '时间模式'}]`);

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('浏览器未就绪'); searchRunning = false; return; }

    await ensureLogin(view);

    const keywords = params.keywords || [];
    const cdp = getCDPInterceptor();
    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const cutoffTs = Math.floor(Date.now() / 1000) - (params.commentHours || 60) * 60;

    let totalMatched = 0;

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!searchRunning || scheduler.shouldAbortSearch()) break;

      const kw = keywords[kwIdx];
      log(`[${kwIdx + 1}/${keywords.length}] 搜索关键词: ${kw}`);

      // 1. 导航到搜索页
      await navigateToSearch(view, kw);
      await sleep(5000, 7000);

      // 2. 切换到"视频"标签页（搜索默认是"综合"）
      log('  切换到视频标签...');
      await clickByText(view, '视频');
      await sleep(2000, 3000);

      // 3. 数量模式：执行排序筛选
      if (isQuantityMode && params.sortMode && params.sortMode !== 'default') {
        log(`  执行排序筛选: ${params.sortMode}`);
        await applySortFilter(view, params.sortMode, params.days);
        await sleep(2000, 3000);
      }

      // 4. 扫描视频列表
      const videos = await scanVideos(view);
      log(`  发现 ${videos.length} 个视频`);

      if (isQuantityMode) {
        // 数量模式：采集指定数量
        const maxVideos = params.maxVideos || 10;
        for (let i = 0; i < Math.min(videos.length, maxVideos); i++) {
          if (!searchRunning || scheduler.shouldAbortSearch()) break;
          log(`  [${i + 1}/${Math.min(videos.length, maxVideos)}] 处理视频 ${videos[i].aid}`);
          const matched = await processVideo(view, videos[i].aid, params, intentKw, garbageKw, cdp, onResult);
          totalMatched += matched;
          await sleep(5000, 15000);
        }
      } else {
        // 时间模式：自然浏览，持续采集直到任务时间到
        let videoIdx = 0;
        const startTime = Date.now();
        const maxDuration = params.taskDuration || 30 * 60 * 1000; // 默认30分钟

        while (searchRunning && !scheduler.shouldAbortSearch()) {
          // 检查任务时间是否到期
          if (Date.now() - startTime >= maxDuration) {
            log(`  任务时间已到（${Math.round(maxDuration / 60000)}分钟），停止采集`);
            break;
          }

          // 如果当前视频列表处理完了，滚动加载更多
          if (videoIdx >= videos.length) {
            log('  滚动加载更多视频...');
            await human.mouseScroll(view.webContents, 'down', 2);
            await sleep(2000, 3000);
            const moreVideos = await scanVideos(view);
            let added = 0;
            for (const v of moreVideos) {
              if (!videos.some(x => x.aid === v.aid)) { videos.push(v); added++; }
            }
            if (added === 0) {
              log('  没有更多视频，停止采集');
              break;
            }
            log(`  新增 ${added} 个视频，总计 ${videos.length} 个`);
          }

          log(`  [${videoIdx + 1}] 处理视频 ${videos[videoIdx].aid} (已用时 ${Math.round((Date.now() - startTime) / 60000)}分钟)`);
          const matched = await processVideo(view, videos[videoIdx].aid, params, intentKw, garbageKw, cdp, onResult);
          totalMatched += matched;
          videoIdx++;
          log(`  进度: 已处理${videoIdx}个视频, 累计命中${totalMatched}条`);

          // 模拟自然浏览间隔
          await sleep(5000, 15000);
        }
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

// ========== 排序筛选 ==========

/**
 * 在搜索结果页执行排序筛选
 * 模拟点击"筛选"按钮 → 选择排序方式 → 选择时间范围
 */
async function applySortFilter(view, sortMode, days) {
  const wc = view.webContents;

  // 模拟点击"筛选"按钮
  const filterPos = await wc.executeJavaScript(`
    (function() {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.includes('筛选')) {
          const r = el.getBoundingClientRect();
          if (r.width > 20 && r.width < 120 && r.y > 30 && r.y < 250)
            return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()
  `);

  if (filterPos) {
    await human.mouseClick(wc, filterPos.x, filterPos.y);
    await sleep(1500, 2500);

    // 选择排序方式
    const sortText = sortMode === 'likes' ? '最多点赞' : sortMode === 'newest' ? '最新发布' : '综合排序';
    const sortPos = await wc.executeJavaScript(`
      (function() {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.innerText || '').trim();
          if (t === '${sortText}') {
            const r = el.getBoundingClientRect();
            if (r.width > 10 && r.height > 10 && r.height < 60 && r.x > 800)
              return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()
    `);

    if (sortPos) {
      await human.mouseClick(wc, sortPos.x, sortPos.y);
      log(`    已选择排序: ${sortText}`);
      await sleep(1500, 2500);
    }

    // 选择时间范围
    const timeText = days <= 1 ? '一天内' : days <= 7 ? '一周内' : '半年内';
    const timePos = await wc.executeJavaScript(`
      (function() {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.innerText || '').trim();
          if (t === '${timeText}') {
            const r = el.getBoundingClientRect();
            if (r.width > 10 && r.height > 10 && r.height < 60 && r.x > 800)
              return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()
    `);

    if (timePos) {
      await human.mouseClick(wc, timePos.x, timePos.y);
      log(`    已选择时间: ${timeText}`);
      await sleep(1500, 2500);
    }

    // 关闭筛选面板
    await human.mouseClick(wc, filterPos.x, filterPos.y);
    await sleep(2000, 3000);
  } else {
    log('    未找到筛选按钮，跳过排序');
  }
}

// ========== 页面操作 ==========

async function ensureLogin(view) {
  try {
    const body = await view.webContents.executeJavaScript('document.body.innerText.substring(0, 300)');
    if (body.includes('登录') && body.length < 100) {
      log('请在浏览器中登录抖音...');
      const LOGIN_TIMEOUT = 120;
      for (let i = 0; i < LOGIN_TIMEOUT; i++) {
        await sleep(3000);
        if (!searchRunning) return;
        try {
          const b = await view.webContents.executeJavaScript('document.body.innerText.substring(0, 300)');
          if (!b.includes('登录') || b.length > 100) { log('登录成功'); return; }
        } catch (e) { log('检查登录状态异常，重试...'); }
      }
      log('登录超时（6分钟），搜索任务终止');
      searchRunning = false;
    }
  } catch (e) { log(`检查登录状态失败: ${e.message}`); }
}

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

async function processVideo(view, aid, params, intentKw, garbageKw, cdp, onResult) {
  try {
    const clicked = await clickVideoById(view, aid);
    if (!clicked) { log('    未定位到视频，跳过'); return 0; }
    await sleep(3000, 5000);

    const wc = view.webContents;
    const videoInfo = { aweme_id: aid, desc: '', author: '', video_url: `https://www.douyin.com/video/${aid}` };

    // 模拟观看
    await human.mouseMove(wc, rand(300, 700), rand(200, 400));
    await sleep(3000, 6000);

    // 打开评论区
    await human.keyPress(wc, 'x');
    await sleep(3000, 4000);

    // 滚动加载评论
    for (let scroll = 0; scroll < 20; scroll++) {
      if (!searchRunning) break;
      await human.mouseScroll(wc, 'down', 1);
      if (Math.random() < 0.3) await human.mouseMove(wc, rand(600, 900), rand(300, 600));
      await sleep(1000, 2000);
    }

    // 采集评论（CDP + DOM）
    const cdpComments = cdp ? cdp.getComments(aid) : [];
    const domComments = await readDomComments(view);
    const domOnly = domComments.filter(d => !cdpComments.some(c => c.text === d.text));
    const allComments = [...cdpComments, ...domOnly];

    if (cdp && cdp.currentVideo && cdp.currentVideo.aweme_id === aid) {
      videoInfo.desc = cdp.currentVideo.desc || '';
      videoInfo.author = cdp.currentVideo.author || '';
    }

    // 逐条匹配处理
    let matched = 0;
    for (const c of allComments) {
      if (!searchRunning) break;
      const result = pipeline.processComment(c, null, videoInfo, { intent: intentKw, garbage: garbageKw });
      if (result) {
        matched++;
        if (onResult) onResult(result);
      }
    }

    log(`    CDP: ${cdpComments.length}条, DOM: ${domComments.length}条, 命中: ${matched}条`);

    await human.keyPress(wc, 'Escape');
    await sleep(2000, 3000);
    return matched;
  } catch (e) {
    log(`    处理视频异常: ${e.message}`);
    try { await human.keyPress(view.webContents, 'Escape'); } catch (e2) {}
    return 0;
  }
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
          result.push({ text: best, nickname: nick, comment_id: 'dom_' + Math.random().toString(36).substr(2, 9) });
        }
        return result;
      })()
    `);
  } catch (e) { return []; }
}

function stopSearch() { searchRunning = false; log('搜索已停止'); }
function pauseSearch() { log('搜索已暂停（由监控任务触发）'); }
function isRunning() { return searchRunning; }

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
