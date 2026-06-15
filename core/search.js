/**
 * 搜索引擎模块
 *
 * 完整流程：
 *   1. 点击搜索框 → 输入关键词 → 点击搜索
 *   2. 切换视频标签 → 鼠标悬停筛选 → 选择排序/时间 → 关闭筛选
 *   3. 扫描视频列表 → 过滤已处理ID → 滚动加载新视频
 *   4. 逐个点击视频 → 等待加载 → 打开评论 → 在评论区滚动 → 采集
 *   5. CDP + DOM 双通道采集完整数据 → 匹配 → 入库 → 推送
 */

const { getDouyinView, getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const pipeline = require('./pipeline');
const scheduler = require('./scheduler');
const { getLogger } = require('./logger');

const logger = getLogger('SearchEngine');
let searchRunning = false;
let logCallback = null;

/** 已处理视频ID集合 */
const processedIds = new Set();

function checkRunning() { return searchRunning; }

// ========== 验证码检测 ==========

async function checkCaptcha(wc) {
  try {
    return await wc.executeJavaScript(`(function(){
      const t = document.body.innerText;
      return t.includes('请完成下列验证') || t.includes('安全验证') || t.includes('拖动完成拼图') || t.includes('人机验证');
    })()`);
  } catch (e) { return false; }
}

async function waitForCaptchaSolved(wc) {
  log('  ⚠️ 验证码！请手动完成验证...');
  notifyUser('检测到验证码，请在左侧页面手动完成验证');
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    if (!checkRunning()) return false;
    if (!(await checkCaptcha(wc))) { log('  ✅ 验证码已通过'); return true; }
  }
  return false;
}

function notifyUser(msg) {
  log(`  🔔 ${msg}`);
  try {
    const { getMainWindow } = require('../main/window');
    const win = getMainWindow();
    if (win?.webContents) win.webContents.send('search-log', `🔔 ${msg}`);
  } catch (e) {}
}

// ========== 登录检查 ==========

async function ensureLogin(wc) {
  const body = await wc.executeJavaScript('document.body.innerText.substring(0, 300)').catch(() => '');
  if (body.includes('登录') && body.length < 100) {
    log('请登录抖音...');
    for (let i = 0; i < 120; i++) {
      await sleep(3000);
      if (!checkRunning()) return false;
      const b = await wc.executeJavaScript('document.body.innerText.substring(0, 300)').catch(() => '');
      if (!b.includes('登录') || b.length > 100) { log('登录成功'); return true; }
    }
    return false;
  }
  return true;
}

// ========== 搜索主流程 ==========

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

    if (!checkRunning()) return;
    if (!(await ensureLogin(wc))) { searchRunning = false; return; }
    if (await checkCaptcha(wc)) {
      if (!(await waitForCaptchaSolved(wc))) { searchRunning = false; return; }
    }

    const keywords = params.keywords || [];
    const cdp = getCDPInterceptor();
    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];

    // 评论时效：只采集这个时间范围内的评论
    const commentHours = params.commentHours || 60; // 默认60分钟
    const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 60;
    log(`  评论时效: ${commentHours}分钟内 (${new Date(cutoffTs * 1000).toLocaleString('zh-CN')})`);

    let totalMatched = 0;

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!checkRunning()) break;
      const kw = keywords[kwIdx];
      log(`[${kwIdx + 1}/${keywords.length}] 搜索关键词: ${kw}`);

      // 步骤1：输入搜索
      if (!checkRunning()) break;
      const searchOk = await typeKeywordAndSearch(view, kw);
      if (!searchOk) { log('  搜索失败'); continue; }
      await sleep(5000, 7000);
      if (await checkCaptcha(wc)) {
        if (!(await waitForCaptchaSolved(wc))) break;
        await sleep(2000);
      }

      // 步骤2：切换视频标签
      if (!checkRunning()) break;
      await clickByText(view, '视频');
      await sleep(2000, 3000);

      // 步骤3：筛选
      if (!checkRunning()) break;
      if (isQuantityMode) {
        const hasFilter = params.sortMode !== 'default' || params.filterTime !== '0' || params.filterDuration !== '0';
        if (hasFilter) {
          log('  筛选...');
          await applySortFilter(view, params);
          await sleep(2000, 3000);
        }
      }

      // 步骤4-5：处理视频（带去重+滚动加载）
      if (!checkRunning()) break;
      const targetCount = isQuantityMode ? (params.maxVideos || 10) : Infinity;
      const startTime = Date.now();
      const maxDuration = isQuantityMode ? Infinity : (params.taskDuration || 30 * 60 * 1000);
      let processedCount = 0;
      let scrollAttempts = 0;

      while (checkRunning() && processedCount < targetCount) {
        // 时间模式检查时间
        if (!isQuantityMode && Date.now() - startTime >= maxDuration) {
          log('  任务时间已到');
          break;
        }

        // 读取当前页面视频列表
        const videos = await scanVideos(view);
        if (videos.length === 0) {
          log('  页面无视频，滚动加载...');
          await human.mouseScroll(wc, 'down', 3);
          await sleep(3000, 5000);
          scrollAttempts++;
          if (scrollAttempts > 10) { log('  多次滚动无新视频，停止'); break; }
          continue;
        }

        // 模拟浏览行为：随机移动鼠标、悬停视频卡片预览
        log(`  浏览 ${videos.length} 个视频...`);
        await simulateBrowseVideos(view, videos);

        // 过滤已处理的ID
        const unprocessed = videos.filter(v => !processedIds.has(v.aid));
        if (unprocessed.length === 0) {
          // 全部处理过，滚动加载更多
          log(`  全部${videos.length}个视频已处理，滚动加载...`);
          await human.mouseScroll(wc, 'down', 3);
          await sleep(3000, 5000);
          scrollAttempts++;
          if (scrollAttempts > 10) { log('  多次滚动无新视频，停止'); break; }
          continue;
        }

        scrollAttempts = 0; // 有新视频，重置滚动计数
        log(`  发现 ${unprocessed.length} 个未处理视频`);

        // 处理第一个未处理的视频
        const video = unprocessed[0];
        processedCount++;
        log(`  [${processedCount}] 处理视频 ${video.aid}`);

        const matched = await processVideo(view, video.aid, params, intentKw, garbageKw, cdp, onResult, cutoffTs);
        totalMatched += matched;

        // 处理间隔
        for (let w = 0; w < 3; w++) {
          if (!checkRunning()) break;
          await sleep(1000, 2000);
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

// ========== 搜索操作 ==========

async function typeKeywordAndSearch(view, keyword) {
  const wc = view.webContents;
  const searchInput = await wc.executeJavaScript(`(function(){
    const e = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, val: e.value || '' };
  })()`).catch(() => null);

  if (!searchInput) { log('    搜索框未找到'); return false; }

  await human.mouseClick(wc, searchInput.x, searchInput.y + 8);
  await sleep(300, 500);

  // 清空：逐个Backspace
  const len = (searchInput.val || '').length;
  if (len > 0) {
    for (let i = 0; i < len; i++) { await human.keyPress(wc, 'Backspace'); await sleep(30, 60); }
    await sleep(200, 400);
  }

  // 输入
  await human.typeText(wc, keyword);
  await sleep(500, 1000);

  // 点搜索按钮
  const btn = await wc.executeJavaScript(`(function(){
    const e = document.querySelector('[data-e2e="searchbar-button"]');
    if (e) { const r = e.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; }
    for (const b of document.querySelectorAll('button,div[role="button"]')) {
      if ((b.innerText||'').trim()==='搜索') { const r = b.getBoundingClientRect(); if (r.width>10&&r.height>10&&r.y<150) return {x:r.x+r.width/2,y:r.y+r.height/2}; }
    }
    return null;
  })()`).catch(() => null);

  if (btn) { await human.mouseClick(wc, btn.x, btn.y); log('    已搜索'); }
  else { await human.keyPress(wc, 'Enter'); }
  return true;
}

// ========== 筛选 ==========

async function applySortFilter(view, params) {
  const wc = view.webContents;
  const fp = await wc.executeJavaScript(`(function(){
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText||'').trim();
      if (t.includes('筛选') && !t.includes('筛选结果')) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.width < 120 && r.y > 30 && r.y < 250)
          return { x: r.x+r.width/2, y: r.y+r.height/2 };
      }
    }
    return null;
  })()`).catch(() => null);
  if (!fp) { log('    筛选按钮未找到'); return; }

  // 悬停打开
  await human.mouseHover(wc, fp.x, fp.y, 50, 20, 2000);
  await sleep(2000, 2500);

  const sortMap = { likes: '最多点赞', newest: '最新发布' };
  if (params.sortMode && sortMap[params.sortMode]) await clickFilterOption(wc, sortMap[params.sortMode]);

  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (params.filterTime && timeMap[params.filterTime]) await clickFilterOption(wc, timeMap[params.filterTime]);

  const durMap = { short: '1分钟以下', mid: '1-5分钟', long: '5分钟以上' };
  if (params.filterDuration && durMap[params.filterDuration]) await clickFilterOption(wc, durMap[params.filterDuration]);

  await sleep(1000, 2000);
  await human.mouseClick(wc, fp.x, fp.y);
  log('    筛选已应用');
  await sleep(2000, 3000);
}

async function clickFilterOption(wc, text) {
  try {
    const pos = await wc.executeJavaScript(`(function(){
      for (const el of document.querySelectorAll('button,span,div,label,a')) {
        const t = (el.innerText||'').trim();
        if (t !== '${text}') continue;
        const r = el.getBoundingClientRect();
        if (r.width>5 && r.height>5 && r.height<60 && r.width<200 && r.y>100)
          return { x:r.x+r.width/2, y:r.y+r.height/2 };
      }
      return null;
    })()`).catch(() => null);
    if (pos) { await human.mouseClick(wc, pos.x, pos.y); await sleep(800, 1500); }
  } catch (e) {}
}

// ========== 模拟浏览视频列表 ==========

async function simulateBrowseVideos(view, videos) {
  const wc = view.webContents;
  const browseCount = Math.min(rand(2, 4), videos.length);
  const indices = [];
  while (indices.length < browseCount) {
    const idx = rand(0, videos.length - 1);
    if (!indices.includes(idx)) indices.push(idx);
  }

  for (const idx of indices) {
    if (!checkRunning()) break;
    const aid = videos[idx].aid;

    // 找到视频卡片位置
    const cardPos = await wc.executeJavaScript(`(function(){
      const links = document.querySelectorAll('a[href*="/video/${aid}"]');
      for (const a of links) {
        const card = a.closest('[class*="card"]') || a;
        const r = card.getBoundingClientRect();
        if (r.width > 50 && r.height > 50)
          return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height };
      }
      return null;
    })()`).catch(() => null);

    if (!cardPos) continue;

    // 鼠标移动到卡片位置（触发预览播放）
    await human.mouseMove(wc, cardPos.x, cardPos.y);
    await sleep(rand(1500, 3000));

    // 在卡片上随机小幅移动（模拟浏览）
    await human.mouseMove(wc, cardPos.x + rand(-30, 30), cardPos.y + rand(-20, 20));
    await sleep(rand(500, 1500));
  }

  // 随机暂停模拟阅读
  await sleep(rand(1000, 3000));
}

// ========== 视频处理 ==========

async function processVideo(view, aid, params, intentKw, garbageKw, cdp, onResult, cutoffTs) {
  if (!checkRunning()) return 0;
  const wc = view.webContents;

  processedIds.add(aid);

  if (await checkCaptcha(wc)) {
    if (!(await waitForCaptchaSolved(wc))) return 0;
  }

  try {
    // 点击视频
    const pos = await wc.executeJavaScript(`(function(){
      const links = document.querySelectorAll('a[href*="/video/${aid}"]');
      for (const a of links) {
        a.scrollIntoView({ block:'center' });
        const r = a.getBoundingClientRect();
        if (r.width>50 && r.height>50) return { x:r.x+r.width/2, y:r.y+r.height/2 };
      }
      return null;
    })()`).catch(() => null);
    if (!pos) { log('    视频未找到'); return 0; }

    await sleep(500, 1000);
    await human.mouseClick(wc, pos.x, pos.y);

    // 等待视频加载
    log('    等待视频加载...');
    await sleep(5000, 8000);
    if (!checkRunning()) return 0;

    // 模拟观看
    await human.mouseMove(wc, rand(300, 700), rand(200, 400));
    await sleep(3000, 5000);

    // 先检查评论数：抢首评 = 无评论，数字 = 有评论
    const commentCount = await wc.executeJavaScript(`
      (function(){
        // 查找评论按钮/评论数显示
        // 抖音评论区通常显示 "抢首评" 或 "XX条"
        const body = document.body.innerText;
        if (body.includes('抢首评')) return 0;
        // 查找评论数：如 "1259条评论" 或评论图标旁边的数字
        const commentBtn = document.querySelector('[data-e2e="comment-icon"], [class*="comment-count"], [class*="CommentCount"]');
        if (commentBtn) {
          const text = commentBtn.innerText || '';
          const m = text.match(/(\\d+)/);
          if (m) return parseInt(m[1]);
        }
        // 备选：查找包含"评"字的元素
        for (const el of document.querySelectorAll('*')) {
          const t = (el.innerText || '').trim();
          if (t.match(/^\\d+$/) && el.nextElementSibling && (el.nextElementSibling.innerText||'').includes('评')) {
            return parseInt(t);
          }
        }
        return -1; // 未知
      })()
    `).catch(() => -1);

    if (commentCount === 0) {
      log('    无评论（抢首评），跳过');
      await human.keyPress(wc, 'Escape');
      await sleep(1000, 2000);
      return 0;
    }
    log(`    评论数: ${commentCount === -1 ? '未知' : commentCount}`);

    // 打开评论
    await human.keyPress(wc, 'x');
    await sleep(4000, 6000);

    // 等待评论区出现
    const hasComment = await wc.executeJavaScript(`
      !!document.querySelector('[data-e2e="comment-list"], [class*="comment-list"], [class*="CommentList"]')
    `).catch(() => false);

    if (!hasComment) {
      log('    评论区未出现，再按x');
      await human.keyPress(wc, 'x');
      await sleep(3000, 5000);
    }

    if (!checkRunning()) return 0;

    // 在评论区内滚动加载
    log('    滚动加载评论...');
    for (let s = 0; s < 12; s++) {
      if (!checkRunning()) break;
      await wc.executeJavaScript(`
        (function(){
          const panel = document.querySelector('[data-e2e="comment-list"], [class*="comment-list"], [class*="CommentList"]');
          if (panel) panel.scrollBy(0, 150);
          else {
            const comment = document.querySelector('[class*="comment"]');
            if (comment) {
              const p = comment.closest('[style*="overflow"]') || comment.parentElement;
              if (p) p.scrollBy(0, 150);
            }
          }
        })()
      `).catch(() => {});
      await sleep(1000, 2000);
    }

    // 采集完整数据
    const videoInfo = { aweme_id: aid, desc: '', author: '', video_url: `https://www.douyin.com/video/${aid}` };
    const cdpComments = cdp ? cdp.getComments(aid) : [];
    const domComments = await readDomComments(view);
    const domOnly = domComments.filter(d => !cdpComments.some(c => c.text === d.text));
    let allComments = [...cdpComments, ...domOnly];

    // 时效过滤：只保留 cutoffTs 之后的评论
    if (cutoffTs > 0) {
      const before = allComments.length;
      allComments = allComments.filter(c => (c.create_time || 0) >= cutoffTs);
      const filtered = before - allComments.length;
      if (filtered > 0) log(`    时效过滤: 排除${filtered}条超时评论`);
    }

    if (cdp?.currentVideo?.aweme_id === aid) {
      videoInfo.desc = cdp.currentVideo.desc || '';
      videoInfo.author = cdp.currentVideo.author || '';
    }

    // 逐条匹配处理
    let matched = 0;
    for (const c of allComments) {
      if (!checkRunning()) break;
      const result = pipeline.processComment(c, null, videoInfo, { intent: intentKw, garbage: garbageKw });
      if (result) { matched++; if (onResult) onResult(result); }
    }

    log(`    CDP:${cdpComments.length} DOM:${domComments.length} 有效:${allComments.length} 命中:${matched}`);

    await human.keyPress(wc, 'Escape');
    await sleep(2000, 3000);
    return matched;
  } catch (e) {
    log(`    异常: ${e.message}`);
    try { await human.keyPress(wc, 'Escape'); } catch (e2) {}
    return 0;
  }
}

  try {
    // 点击视频
    const pos = await wc.executeJavaScript(`(function(){
      const links = document.querySelectorAll('a[href*="/video/${aid}"]');
      for (const a of links) {
        a.scrollIntoView({ block:'center' });
        const r = a.getBoundingClientRect();
        if (r.width>50 && r.height>50) return { x:r.x+r.width/2, y:r.y+r.height/2 };
      }
      return null;
    })()`).catch(() => null);
    if (!pos) { log('    视频未找到'); return 0; }

    await sleep(500, 1000);
    await human.mouseClick(wc, pos.x, pos.y);

    // 等待视频加载
    log('    等待视频加载...');
    await sleep(5000, 8000);
    if (!checkRunning()) return 0;

    // 模拟观看
    await human.mouseMove(wc, rand(300, 700), rand(200, 400));
    await sleep(3000, 5000);

    // 打开评论
    await human.keyPress(wc, 'x');
    await sleep(4000, 6000);

    // 等待评论区出现
    const hasComment = await wc.executeJavaScript(`
      !!document.querySelector('[data-e2e="comment-list"], [class*="comment-list"], [class*="CommentList"]')
    `).catch(() => false);

    if (!hasComment) {
      log('    评论区未出现，再按x');
      await human.keyPress(wc, 'x');
      await sleep(3000, 5000);
    }

    if (!checkRunning()) return 0;

    // 在评论区内滚动加载
    log('    滚动加载评论...');
    for (let s = 0; s < 12; s++) {
      if (!checkRunning()) break;
      // 找到评论区并滚动
      await wc.executeJavaScript(`
        (function(){
          const panel = document.querySelector('[data-e2e="comment-list"], [class*="comment-list"], [class*="CommentList"]');
          if (panel) panel.scrollBy(0, 150);
          else {
            const comment = document.querySelector('[class*="comment"]');
            if (comment) {
              const p = comment.closest('[style*="overflow"]') || comment.parentElement;
              if (p) p.scrollBy(0, 150);
            }
          }
        })()
      `).catch(() => {});
      await sleep(1000, 2000);
    }

    // 采集完整数据
    const videoInfo = { aweme_id: aid, desc: '', author: '', video_url: `https://www.douyin.com/video/${aid}` };

    // CDP 拦截的评论（完整API数据）
    const cdpComments = cdp ? cdp.getComments(aid) : [];
    // DOM 采集的评论（补充）
    const domComments = await readDomComments(view);
    // 合并去重
    const domOnly = domComments.filter(d => !cdpComments.some(c => c.text === d.text));
    const allComments = [...cdpComments, ...domOnly];

    // 补充视频信息
    if (cdp?.currentVideo?.aweme_id === aid) {
      videoInfo.desc = cdp.currentVideo.desc || '';
      videoInfo.author = cdp.currentVideo.author || '';
    }

    // 逐条处理：匹配 → 入库 → 推送
    let matched = 0;
    for (const c of allComments) {
      if (!checkRunning()) break;
      const result = pipeline.processComment(c, null, videoInfo, { intent: intentKw, garbage: garbageKw });
      if (result) { matched++; if (onResult) onResult(result); }
    }

    log(`    CDP:${cdpComments.length} DOM:${domComments.length} 命中:${matched}`);

    // 退出视频
    await human.keyPress(wc, 'Escape');
    await sleep(2000, 3000);
    return matched;
  } catch (e) {
    log(`    异常: ${e.message}`);
    try { await human.keyPress(wc, 'Escape'); } catch (e2) {}
    return 0;
  }
}

// ========== 工具 ==========

async function clickByText(view, text) {
  try {
    const pos = await view.webContents.executeJavaScript(`(function(){
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText||'').trim();
        if (t === '${text}') {
          const r = el.getBoundingClientRect();
          if (r.width>10 && r.height>10 && r.height<50 && r.y<200 && r.y>30)
            return { x:r.x+r.width/2, y:r.y+r.height/2 };
        }
      }
      return null;
    })()`).catch(() => null);
    if (pos) await human.mouseClick(view.webContents, pos.x, pos.y);
  } catch (e) {}
}

async function scanVideos(view) {
  try {
    return await view.webContents.executeJavaScript(`(function(){
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
    })()`).catch(() => []);
  } catch (e) { return []; }
}

async function readDomComments(view) {
  try {
    return await view.webContents.executeJavaScript(`(function(){
      const result = [];
      const seen = new Set();
      const SKIP = new Set(['回复','分享','作者赞过','收起','展开','举报','复制','删除','赞','踩','抢沙发','添加表情']);
      const items = document.querySelectorAll('[data-e2e="comment-list"] > div > div, [class*="comment-item"], [class*="CommentItem"]');
      for (const item of items) {
        let best = '';
        let nick = '';
        for (const el of item.querySelectorAll('p, span, div')) {
          const t = (el.innerText||'').trim();
          if (!t || t.length<3 || t.length>500 || SKIP.has(t)) continue;
          if (/^\\d+$/.test(t) || /^[\\d\\.]+万?$/.test(t)) continue;
          if (t.length > best.length) best = t;
        }
        if (!best || best.length<4 || seen.has(best)) continue;
        seen.add(best);
        const ne = item.querySelector('a[href*="/user/"]');
        if (ne) { const nt = (ne.innerText||'').trim(); if (nt.length>0 && nt.length<30 && !SKIP.has(nt)) nick = nt; }
        result.push({ text:best, nickname:nick, comment_id:'dom_'+Math.random().toString(36).substr(2,9) });
      }
      return result;
    })()`).catch(() => []);
  } catch (e) { return []; }
}

function stopSearch() { searchRunning = false; log('搜索已停止'); }
function pauseSearch() { log('搜索已暂停'); }
function isRunning() { return searchRunning; }
function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }
function sleep(min, max) { const ms = max ? Math.floor(Math.random()*(max-min)+min) : min; return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random()*(max-min)+min); }

module.exports = { startSearch, stopSearch, pauseSearch, isRunning };
