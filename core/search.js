/**
 * 执行搜索（稳定版）
 * 导航用 loadURL（可靠），验证只读 URL（不重新加载）
 */
async function executeSearch(view, keyword, task) {
  const wc = view.webContents;

  // 直接导航到搜索页（loadURL 比操作 DOM 更可靠）
  const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`;
  log(`  导航到: ${keyword}`);
  try {
    await wc.loadURL(searchUrl);
  } catch (e) {
    log(`  ❌ 导航失败: ${e.message}`);
    return false;
  }

  // 等待页面加载
  await dom.sleep(5000, 7000);

  // 验证：只读当前 URL，不重新加载
  const currentUrl = await execJS(wc, 'location.href') || '';
  const currentTitle = await execJS(wc, 'document.title') || '';
  const isSearch = currentUrl.includes('search') || currentTitle.includes('搜索');
  log(`  验证: URL=${currentUrl.substring(0, 60)}`);
  log(`  验证: 标题=${currentTitle}`);
  log(`  验证: ${isSearch ? '✓ 已到搜索页' : '✗ 未到搜索页'}`);

  // 验证码检查
  if (await dom.hasCaptcha(view)) {
    log('  ⚠ 验证码，等待处理...');
    notifyUser('验证码检测到，请手动完成');
    for (let i = 0; i < 100; i++) {
      await sleep(3000);
      if (task.stopped) return false;
      if (!(await dom.hasCaptcha(view))) { log('  ✓ 验证码已通过'); break; }
    }
  }

  return isSearch;
}

function pauseSearch() {
  if (searchRunning) {
    searchPaused = !searchPaused;
    log(searchPaused ? '搜索已暂停' : '搜索已继续');
  }
}

function isRunning() { return searchRunning; }

// ========== 主流程 ==========

async function startSearch(params, onLog, onResult, onProgress) {
  if (searchRunning) { log('已有搜索任务在运行中'); return; }

  searchRunning = true;
  searchPaused = false;
  logCallback = onLog;
  progressCallback = onProgress || null;

  const task = {
    params,
    processedIds: new Set(),
    stopped: false,
    matchedTotal: 0,
    cdpTotal: 0,
    domTotal: 0,
    videoIndex: 0,
    videoTotal: 0
  };
  currentTask = task;
  scheduler.registerSearch(params);

  const isQuantityMode = params.sortEnabled;
  log(`搜索任务启动 [${isQuantityMode ? '数量模式' : '时间模式'}] - 关键词 ${params.keywords.length} 个`);

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('浏览器未就绪'); return; }
    const wc = view.webContents;

    // 检查登录
    const loginBody = await execJS(wc, 'document.body.innerText.substring(0, 300)') || '';
    if (loginBody.includes('登录') && loginBody.length < 100) {
      log('请登录抖音...');
      for (let i = 0; i < 120; i++) {
        await sleep(3000);
        if (task.stopped) return;
        const b = await execJS(wc, 'document.body.innerText.substring(0, 300)') || '';
        if (!b.includes('登录') || b.length > 100) { log('登录成功'); break; }
      }
    }

    // 检查验证码
    if (await dom.hasCaptcha(view)) {
      log('⚠ 验证码检测到，请手动完成...');
      notifyUser('检测到验证码，请在左侧页面手动完成');
      for (let i = 0; i < 100; i++) {
        await sleep(3000);
        if (task.stopped) return;
        if (!(await dom.hasCaptcha(view))) { log('✅ 验证码已通过'); break; }
      }
    }

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const keywords = params.keywords || [];
    const commentHours = params.commentHours || 60;
    const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 60;
    log(`评论时效: ${commentHours}分钟内`);

    const cdp = getCDPInterceptor();

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (task.stopped) break;
      const kw = keywords[kwIdx];
      log(`[${kwIdx + 1}/${keywords.length}] 搜索关键词: ${kw}`);

      // 执行搜索
      const searchOk = await executeSearch(view, kw, task);
      if (!searchOk) { log('❌ 搜索失败'); continue; }

      // 切换视频标签
      await clickByTextSafe(view, '视频');
      await dom.sleep(2000, 3000);

      // 筛选
      if (isQuantityMode) {
        const hasFilter = params.sortMode !== 'default' || params.filterTime !== '0' || params.filterDuration !== '0';
        if (hasFilter) {
          log('执行筛选...');
          await applySortFilter(view, params);
          await dom.sleep(2000, 3000);
        }
      }

      // 处理视频
      const targetCount = isQuantityMode ? (params.maxVideos || 10) : Infinity;
      const startTime = Date.now();
      const maxDuration = isQuantityMode ? Infinity : (params.taskDuration || 30 * 60 * 1000);
      let scrollAttempts = 0;

      while (!task.stopped && task.processedIds.size < targetCount) {
        if (searchPaused) {
          await waitWhilePaused(task);
          if (task.stopped) break;
        }
        if (!isQuantityMode && Date.now() - startTime >= maxDuration) {
          log('任务时间已到');
          break;
        }

        // 扫描视频
        const videos = await dom.scanVideoLinks(view);
        if (videos.length === 0) {
          log('页面无视频，滚动加载...');
          await human.mouseScroll(wc, 'down', 3);
          await dom.sleep(3000, 5000);
          scrollAttempts++;
          if (scrollAttempts > 10) { log('多次滚动无新视频，停止'); break; }
          continue;
        }

        // 模拟浏览
        await simulateBrowse(view, videos);

        // 过滤已处理
        const unprocessed = videos.filter(v => !task.processedIds.has(v.aid));
        if (unprocessed.length === 0) {
          log(`全部${videos.length}个视频已处理，滚动加载...`);
          await human.mouseScroll(wc, 'down', 3);
          await dom.sleep(3000, 5000);
          scrollAttempts++;
          if (scrollAttempts > 10) { log('多次滚动无新视频，停止'); break; }
          continue;
        }

        scrollAttempts = 0;
        log(`发现 ${unprocessed.length} 个未处理视频`);

        const video = unprocessed[0];
        task.processedIds.add(video.aid);
        task.videoIndex = task.processedIds.size;
        task.videoTotal = Math.max(task.videoTotal, task.videoIndex);
        log(`[${task.videoIndex}/${targetCount === Infinity ? '∞' : targetCount}] 处理视频 ${video.aid}`);

        // 验证码检查
        if (await dom.hasCaptcha(view)) {
          log('⚠ 验证码检测到，等待处理...');
          notifyUser('验证码检测到，请手动完成');
          for (let i = 0; i < 100; i++) {
            await sleep(3000);
            if (task.stopped) break;
            if (!(await dom.hasCaptcha(view))) { log('✅ 验证码已通过'); break; }
          }
        }

        const r = await videoProcessor.processVideo({
          view, aid: video.aid,
          keywords: { intent: intentKw, garbage: garbageKw },
          cdp,
          shouldContinue: () => !task.stopped && searchRunning,
          onProgress: (info) => reportProgress(info, task),
          onResult,
          cutoffTs
        });

        task.matchedTotal += r.matched;
        task.cdpTotal += r.cdp;
        task.domTotal += r.dom;

        await dom.sleep(1000, 2000);
      }
    }

    log(`搜索完成！共 ${task.matchedTotal} 条意向`);
  } catch (e) {
    log(`搜索异常: ${e.message}`);
    logger.error(`startSearch 异常: ${e.stack || e.message}`);
  } finally {
    searchRunning = false;
    searchPaused = false;
    currentTask = null;
    scheduler.notifySearchDone();
  }
}

// ========== 搜索执行 ==========

async function executeSearch(view, keyword, task) {
  const wc = view.webContents;

  // 步骤1：找搜索框（多策略）
  const si = await dom.findSearchInput(view);
  if (!si) {
    log('❌ 搜索框未找到');
    return false;
  }
  log(`  搜索框: (${Math.round(si.x)},${Math.round(si.y)}) [${si.strategy}]`);

  // 步骤2：点击搜索框
  await human.mouseClick(wc, si.x, si.y + 8);
  await dom.sleep(400, 600);

  // 步骤3：设置搜索值（JS 直接设置，比键盘更可靠）
  const setValue = await dom.setSearchInputValue(view, keyword);
  if (!setValue) {
    log('❌ 搜索框值设置失败');
    return false;
  }
  await dom.sleep(500, 800);

  // 验证输入
  const verified = await dom.verifySearchInput(view, keyword);
  log(`  输入验证: ${verified ? '✓' : '✗'}`);
  if (!verified) {
    log('  输入未生效，重试...');
    await dom.setSearchInputValue(view, keyword);
    await dom.sleep(500, 800);
  }

  // 步骤4：点击搜索按钮
  const btn = await dom.findSearchButton(view);
  if (btn) {
    await human.mouseClick(wc, btn.x, btn.y);
    log(`  ✓ 已点击搜索按钮 [${btn.strategy}]`);
  } else {
    log('  搜索按钮未找到，按回车');
    await human.keyPress(wc, 'Enter');
  }

  // 等待搜索结果
  log('  等待搜索结果...');
  await dom.sleep(3000, 5000);

  // 验证是否到搜索结果页
  const url = await execJS(wc, 'location.href') || '';
  const title = await execJS(wc, 'document.title') || '';
  const isSearch = url.includes('search') || title.includes('搜索');
  log(`  验证: URL=${url.substring(0, 60)}`);
  log(`  验证: ${isSearch ? '✓ 已到搜索页' : '✗ 未到搜索页'}`);

  return isSearch;
}

// ========== 筛选 ==========

async function applySortFilter(view, params) {
  const wc = view.webContents;

  // 找筛选按钮
  const fp = await execJS(wc, `(function(){
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText||'').trim();
      if (t.includes('筛选') && !t.includes('筛选结果')) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.width < 120 && r.y > 30 && r.y < 250)
          return { x: r.x+r.width/2, y: r.y+r.height/2 };
      }
    }
    return null;
  })()`);

  if (!fp) { log('  筛选按钮未找到'); return; }

  // 悬停打开
  await human.mouseHover(wc, fp.x, fp.y, 50, 20, 2000);
  await dom.sleep(2000, 2500);

  // 选择选项
  const sortMap = { likes: '最多点赞', newest: '最新发布' };
  if (params.sortMode && sortMap[params.sortMode]) await clickFilterOption(wc, sortMap[params.sortMode]);
  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (params.filterTime && timeMap[params.filterTime]) await clickFilterOption(wc, timeMap[params.filterTime]);
  const durMap = { short: '1分钟以下', mid: '1-5分钟', long: '5分钟以上' };
  if (params.filterDuration && durMap[params.filterDuration]) await clickFilterOption(wc, durMap[params.filterDuration]);

  await dom.sleep(1000, 2000);
  await human.mouseClick(wc, fp.x, fp.y);
  log('  筛选已应用');
  await dom.sleep(2000, 3000);
}

async function clickFilterOption(wc, text) {
  try {
    const pos = await execJS(wc, `(function(){
      for (const el of document.querySelectorAll('button,span,div,label,a')) {
        const t = (el.innerText||'').trim();
        if (t !== '${text.replace(/'/g, "\\'")}') continue;
        const r = el.getBoundingClientRect();
        if (r.width>5 && r.height>5 && r.height<60 && r.width<200 && r.y>100)
          return { x:r.x+r.width/2, y:r.y+r.height/2 };
      }
      return null;
    })()`);
    if (pos) { await human.mouseClick(wc, pos.x, pos.y); await dom.sleep(800, 1500); }
  } catch (e) {}
}

// ========== 辅助 ==========

async function simulateBrowse(view, videos) {
  const wc = view.webContents;
  const count = Math.min(Math.floor(Math.random() * 3) + 2, videos.length);
  const indices = [];
  while (indices.length < count) {
    const idx = Math.floor(Math.random() * videos.length);
    if (!indices.includes(idx)) indices.push(idx);
  }
  for (const idx of indices) {
    if (!checkRunning()) break;
    const aid = videos[idx].aid;
    const pos = await execJS(wc, `(function(){
      const links = document.querySelectorAll('a[href*="/video/${aid}"]');
      for (const a of links) {
        const r = a.getBoundingClientRect();
        if (r.width > 50 && r.height > 50) return { x: r.x+r.width/2, y: r.y+r.height/2 };
      }
      return null;
    })()`);
    if (!pos) continue;
    await human.mouseMove(wc, pos.x, pos.y);
    await dom.sleep(1500, 3000);
  }
  await dom.sleep(1000, 3000);
}

async function clickByTextSafe(view, text) {
  return await dom.clickByText(view, text);
}

async function execJS(wc, script) {
  try { return await wc.executeJavaScript(script); } catch (_) { return null; }
}

function reportProgress(info, task) {
  if (info.phase === 'error' && info.error) log(`  [跳过] ${info.awemeId}: ${info.error}`);
  if (info.phase === 'done') log(`  [完成] CDP:${info.cdpCount} DOM:${info.domCount} 命中:${info.matchCount}`);
  if (progressCallback) {
    try { progressCallback({ ...info, videoIndex: task.videoIndex, videoTotal: task.videoTotal, matchedTotal: task.matchedTotal }); } catch (_) {}
  }
}

async function waitWhilePaused(task) {
  while (searchPaused && !task.stopped) { await sleep(500); }
}

function notifyUser(msg) {
  log(`🔔 ${msg}`);
  try {
    const { getMainWindow } = require('../main/window');
    const win = getMainWindow();
    if (win?.webContents) win.webContents.send('search-log', `🔔 ${msg}`);
  } catch (e) {}
}

function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }
function sleep(min, max) { const ms = max ? Math.floor(Math.random()*(max-min)+min) : min; return new Promise(r => setTimeout(r, ms)); }

module.exports = { startSearch, stopSearch, pauseSearch, isRunning };
