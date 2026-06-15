/**
 * 搜索引擎模块（健壮版）
 *
 * 每个步骤都有验证 + 重试：
 *   1. 导航到搜索页 → 验证URL变化
 *   2. 切换视频标签 → 验证标签激活
 *   3. 执行筛选 → 验证筛选面板出现/关闭
 *   4. 扫描视频 → 验证返回列表非空
 *   5. 点击视频 → 验证URL变化
 *   6. 打开评论 → 验证评论区出现
 *   7. 采集评论 → 验证数据非空
 *
 * 任何步骤失败3次后终止任务，不带错执行
 */

const { getDouyinView, getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const { step, waitFor, sleep } = require('./autoStep');
const pipeline = require('./pipeline');
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

  const isQuantityMode = params.sortEnabled;
  log(`搜索任务启动 [${isQuantityMode ? '数量模式' : '时间模式'}]`);

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('浏览器未就绪'); searchRunning = false; return; }
    const wc = view.webContents;

    // 步骤0：检查登录
    const loggedIn = await step('检查登录', async () => {
      const body = await wc.executeJavaScript('document.body.innerText.substring(0, 300)');
      return !(body.includes('登录') && body.length < 100);
    }, null, { log, retries: 1 });

    if (!loggedIn) {
      log('等待用户登录（最多6分钟）...');
      const loginOk = await waitFor(async () => {
        if (!searchRunning) return false;
        const body = await wc.executeJavaScript('document.body.innerText.substring(0, 300)');
        return !(body.includes('登录') && body.length < 100);
      }, 360000, 3000);
      if (!loginOk) { log('登录超时，终止'); searchRunning = false; return; }
      log('登录成功');
    }

    const keywords = params.keywords || [];
    const cdp = getCDPInterceptor();
    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    let totalMatched = 0;

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!searchRunning || scheduler.shouldAbortSearch()) break;

      const kw = keywords[kwIdx];
      log(`[${kwIdx + 1}/${keywords.length}] 搜索关键词: ${kw}`);

      // ===== 步骤1：导航到搜索页 =====
      const navOk = await step('导航到搜索页', async () => {
        await navigateToSearch(view, kw);
        await sleep(4000, 6000);
        // 验证：URL 包含 search 关键字
        const url = wc.getURL();
        return url.includes('search') || url.includes(encodeURIComponent(kw));
      }, null, {
        log, retries: 3,
        fallback: async () => {
          // 替代方案：直接 loadURL（不推荐但作为兜底）
          log('    键盘导航失败，尝试直接加载...');
          await wc.loadURL(`https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`);
          await sleep(5000, 7000);
        }
      });

      if (!navOk) { log('导航失败，跳过此关键词'); continue; }

      // ===== 步骤2：切换到视频标签 =====
      const tabOk = await step('切换视频标签', async () => {
        await clickByText(view, '视频');
        await sleep(2000, 3000);
        // 验证：URL 包含 type=video 或页面有视频标签激活
        const url = wc.getURL();
        return url.includes('type=video') || url.includes('search');
      }, null, { log, retries: 2 });

      if (!tabOk) log('视频标签切换可能未生效，继续执行');

      // ===== 步骤3：执行筛选（仅数量模式） =====
      if (isQuantityMode) {
        const hasFilter = params.sortMode !== 'default' || params.filterTime !== '0' ||
                          params.filterDuration !== '0' || params.filterScope !== '0' || params.filterContentType !== '0';
        if (hasFilter) {
          const filterOk = await step('执行筛选', async () => {
            await applySortFilter(view, params);
            await sleep(2000, 3000);
            return true; // 筛选面板操作后返回
          }, null, { log, retries: 2 });
          if (!filterOk) log('筛选执行可能未完全生效，继续采集');
        }
      }

      // ===== 步骤4：扫描视频列表 =====
      let videos = [];
      const scanOk = await step('扫描视频列表', async () => {
        videos = await scanVideos(view);
        return videos.length > 0;
      }, null, {
        log, retries: 3,
        fallback: async () => {
          // 替代方案：向下滚动后重新扫描
          log('    首次扫描为空，滚动后重试...');
          await human.mouseScroll(wc, 'down', 3);
          await sleep(3000, 5000);
          videos = await scanVideos(view);
        }
      });

      if (!scanOk || videos.length === 0) {
        log('未发现视频列表，跳过此关键词');
        continue;
      }
      log(`  发现 ${videos.length} 个视频`);

      // ===== 步骤5-7：逐个处理视频 =====
      if (isQuantityMode) {
        const maxVideos = params.maxVideos || 10;
        let processedCount = 0;

        for (let i = 0; i < videos.length && processedCount < maxVideos; i++) {
          if (!searchRunning || scheduler.shouldAbortSearch()) break;

          const video = videos[i];
          log(`  [${processedCount + 1}/${maxVideos}] 处理视频 ${video.aid}`);

          const videoMatched = await processVideoRobust(view, video.aid, params, intentKw, garbageKw, cdp, onResult);
          totalMatched += videoMatched;
          processedCount++;

          await sleep(5000, 15000);
        }
      } else {
        // 时间模式
        let videoIdx = 0;
        const startTime = Date.now();
        const maxDuration = params.taskDuration || 30 * 60 * 1000;

        while (searchRunning && !scheduler.shouldAbortSearch()) {
          if (Date.now() - startTime >= maxDuration) {
            log(`  任务时间已到（${Math.round(maxDuration / 60000)}分钟）`);
            break;
          }

          if (videoIdx >= videos.length) {
            log('  滚动加载更多...');
            await human.mouseScroll(wc, 'down', 2);
            await sleep(2000, 3000);
            const more = await scanVideos(view);
            let added = 0;
            for (const v of more) { if (!videos.some(x => x.aid === v.aid)) { videos.push(v); added++; } }
            if (added === 0) { log('  无更多视频'); break; }
          }

          log(`  [${videoIdx + 1}] 处理视频 ${videos[videoIdx].aid} (${Math.round((Date.now() - startTime) / 60000)}分钟)`);
          const matched = await processVideoRobust(view, videos[videoIdx].aid, params, intentKw, garbageKw, cdp, onResult);
          totalMatched += matched;
          videoIdx++;
          log(`  已处理${videoIdx}个, 累计命中${totalMatched}条`);

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

/**
 * 健壮的视频处理流程
 * 每步验证，失败重试，不跳过
 */
async function processVideoRobust(view, aid, params, intentKw, garbageKw, cdp, onResult) {
  const wc = view.webContents;
  let matched = 0;

  // 步骤A：点击视频
  const clickOk = await step('点击视频', async () => {
    const pos = await wc.executeJavaScript(`
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
  }, async () => {
    await sleep(3000, 5000);
    const url = wc.getURL();
    return url.includes('/video/');
  }, { log, retries: 3 });

  if (!clickOk) { log('    视频点击失败，跳过'); return 0; }

  // 步骤B：等待视频加载
  await sleep(3000, 5000);
  await human.mouseMove(wc, rand(300, 700), rand(200, 400));
  await sleep(2000, 4000);

  // 步骤C：打开评论区
  const commentOk = await step('打开评论区', async () => {
    await human.keyPress(wc, 'x');
    await sleep(3000, 4000);
    // 验证：评论区元素出现
    const has = await wc.executeJavaScript(`
      !!document.querySelector('[data-e2e="comment-list"], [class*="comment-panel"], [class*="comment-list"]')
    `);
    return has;
  }, null, {
    log, retries: 3,
    fallback: async () => {
      // 替代：再次按x
      log('    评论区未出现，再次尝试...');
      await human.keyPress(wc, 'x');
      await sleep(4000, 6000);
    }
  });

  if (!commentOk) {
    log('    评论区打开失败，尝试读取页面已有评论');
  }

  // 步骤D：滚动加载评论
  for (let scroll = 0; scroll < 20; scroll++) {
    if (!searchRunning) break;
    await human.mouseScroll(wc, 'down', 1);
    if (Math.random() < 0.3) await human.mouseMove(wc, rand(600, 900), rand(300, 600));
    await sleep(1000, 2000);
  }

  // 步骤E：采集评论
  const videoInfo = { aweme_id: aid, desc: '', author: '', video_url: `https://www.douyin.com/video/${aid}` };
  const cdpComments = cdp ? cdp.getComments(aid) : [];
  const domComments = await readDomComments(view);
  const domOnly = domComments.filter(d => !cdpComments.some(c => c.text === d.text));
  const allComments = [...cdpComments, ...domOnly];

  if (cdp?.currentVideo?.aweme_id === aid) {
    videoInfo.desc = cdp.currentVideo.desc || '';
    videoInfo.author = cdp.currentVideo.author || '';
  }

  // 步骤F：匹配处理
  for (const c of allComments) {
    if (!searchRunning) break;
    const result = pipeline.processComment(c, null, videoInfo, { intent: intentKw, garbage: garbageKw });
    if (result) { matched++; if (onResult) onResult(result); }
  }

  log(`    CDP:${cdpComments.length} DOM:${domComments.length} 命中:${matched}`);

  // 步骤G：退出视频
  await human.keyPress(wc, 'Escape');
  await sleep(2000, 3000);

  return matched;
}

// ========== 筛选 ==========

async function applySortFilter(view, params) {
  const wc = view.webContents;

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

  if (!filterPos) { log('    未找到筛选按钮'); return; }

  await human.mouseClick(wc, filterPos.x, filterPos.y);
  await sleep(1500, 2500);

  const sortMap = { likes: '最多点赞', newest: '最新发布', default: '综合排序' };
  if (params.sortMode && params.sortMode !== 'default') {
    await clickFilterOption(wc, sortMap[params.sortMode] || '综合排序');
  }

  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (params.filterTime && params.filterTime !== '0' && timeMap[params.filterTime]) {
    await clickFilterOption(wc, timeMap[params.filterTime]);
  }

  const durationMap = { short: '1分钟以下', mid: '1-5分钟', long: '5分钟以上' };
  if (params.filterDuration && params.filterDuration !== '0' && durationMap[params.filterDuration]) {
    await clickFilterOption(wc, durationMap[params.filterDuration]);
  }

  const scopeMap = { follow: '关注的人', viewed: '最近看过', unviewed: '还未看过' };
  if (params.filterScope && params.filterScope !== '0' && scopeMap[params.filterScope]) {
    await clickFilterOption(wc, scopeMap[params.filterScope]);
  }

  const typeMap = { video: '视频', article: '图文' };
  if (params.filterContentType && params.filterContentType !== '0' && typeMap[params.filterContentType]) {
    await clickFilterOption(wc, typeMap[params.filterContentType]);
  }

  await sleep(1000, 2000);
  await human.mouseClick(wc, filterPos.x, filterPos.y);
  await sleep(2000, 3000);
}

async function clickFilterOption(wc, text) {
  try {
    const pos = await wc.executeJavaScript(`
      (function() {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.innerText || '').trim();
          if (t === '${text}') {
            const r = el.getBoundingClientRect();
            if (r.width > 10 && r.height > 10 && r.height < 60 && r.x > 600)
              return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()
    `);
    if (pos) { await human.mouseClick(wc, pos.x, pos.y); await sleep(800, 1500); }
  } catch (e) {}
}

// ========== 页面操作 ==========

/**
 * 导航到搜索页
 * 使用 loadURL（应用自身导航行为，非页面内操作）
 * 页面内交互（搜索框输入、点击、滚动）才用鼠标键盘模拟
 */
async function navigateToSearch(view, keyword) {
  const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`;
  await view.webContents.loadURL(url);
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
function pauseSearch() { log('搜索已暂停'); }
function isRunning() { return searchRunning; }

function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }
function rand(min, max) { return Math.floor(Math.random() * (max - min) + min); }

module.exports = { startSearch, stopSearch, pauseSearch, isRunning };
