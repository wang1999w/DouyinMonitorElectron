/**
 * 搜索引擎（自知版）
 *
 * 核心原则：
 *   1. 每步操作前知道自己在哪，操作后验证结果
 *   2. 失败时记录原因，不盲目重试
 *   3. 暂停/停止随时响应
 *   4. 循环有退出条件，不死循环
 */

const { getDouyinView, getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const dom = require('./domUtils');
const videoProcessor = require('./videoProcessor');
const scheduler = require('./scheduler');
const { getLogger } = require('./logger');

const logger = getLogger('SearchEngine');

let searchRunning = false;
let searchPaused = false;
let logCallback = null;
let currentTask = null;

function checkRunning() { return searchRunning; }

function stopSearch() {
  searchRunning = false;
  searchPaused = false;
  if (currentTask) currentTask.stopped = true;
  log('🛑 搜索已停止');
}

function pauseSearch() {
  if (!searchRunning) return;
  searchPaused = !searchPaused;
  log(searchPaused ? '⏸ 暂停' : '▶ 继续');
}

function isRunning() { return searchRunning; }
function isPaused() { return searchPaused; }

// ========== 可中断等待 ==========

async function wait(ms) {
  const step = 300;
  for (let t = 0; t < ms; t += step) {
    if (!searchRunning) return false;
    if (searchPaused) {
      log('⏸ 已暂停');
      while (searchPaused) {
        await sleep(300);
        if (!searchRunning) return false;
      }
      log('▶ 已恢复');
    }
    await sleep(step);
  }
  return true;
}

// ========== 主流程 ==========

async function startSearch(params, onLog, onResult) {
  if (searchRunning) { log('已有任务在运行'); return; }
  searchRunning = true;
  searchPaused = false;
  logCallback = onLog;

  const task = {
    params,
    processedIds: new Set(),
    stopped: false,
    matchedTotal: 0
  };
  currentTask = task;
  scheduler.registerSearch(params);

  const isQuantityMode = params.sortEnabled;
  log(`🚀 启动 [${isQuantityMode ? '数量' : '时间'}模式]`);

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('❌ 浏览器未就绪'); return; }
    const wc = view.webContents;

    // ===== 检查登录 =====
    log('📋 检查登录...');
    const isLoggedIn = await checkLogin(wc);
    if (!isLoggedIn) {
      log('❌ 未登录，请先登录抖音');
      return;
    }
    log('✅ 已登录');

    // ===== 检查当前页面状态 =====
    log('🔍 检查页面状态...');
    const currentUrl = await js(wc, 'location.href') || '';
    const isSearchPage = currentUrl.includes('search');
    const isDouyin = currentUrl.includes('douyin.com');

    if (!isDouyin) {
      log('  不在抖音页面，导航到首页...');
      await wc.loadURL('https://www.douyin.com');
      await wait(5000, 7000);
    } else if (isSearchPage) {
      log('  当前在搜索结果页，先回首页...');
      await wc.loadURL('https://www.douyin.com');
      await wait(5000, 7000);
    } else {
      log('  ✓ 在首页');
    }

    // ===== 检查验证码 =====
    if (await dom.hasCaptcha(view)) {
      log('⚠️ 验证码！请手动完成');
      while (await dom.hasCaptcha(view) && searchRunning) await wait(3000);
      if (!searchRunning) return;
      log('✅ 验证码已通过');
    }

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const keywords = params.keywords || [];
    const commentHours = params.commentHours || 60;
    const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 60;
    const cdp = getCDPInterceptor();

    // ===== 关键词循环 =====
    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!searchRunning) break;
      const kw = keywords[kwIdx];
      log(`\n━━━ [${kwIdx+1}/${keywords.length}] 关键词: ${kw} ━━━`);

      // 步骤1：搜索
      const searchOk = await doSearch(view, kw);
      if (!searchOk) { log('❌ 搜索失败，跳过'); continue; }

      // 步骤2：切换视频标签
      log('📋 切换视频标签...');
      const tabPos = await findText(view, '视频');
      if (tabPos) {
        await human.mouseClick(wc, tabPos.x, tabPos.y);
        await wait(2000, 3000);
        log('✅ 已切换');
      } else {
        log('⚠️ 视频标签未找到，继续');
      }

      // 步骤3：筛选（数量模式）
      if (isQuantityMode && (params.sortMode !== 'default' || params.filterTime !== '0')) {
        log('🔍 筛选...');
        await doFilter(view, params);
      }

      // 步骤4：视频处理循环
      const target = isQuantityMode ? (params.maxVideos || 10) : 999;
      let count = 0;
      let fails = 0;
      let scrollTry = 0;
      let sincePause = 0;
      let pauseAfter = rand(1, 3);

      while (searchRunning && count < target) {
        // 扫描视频
        const videos = await dom.scanVideoLinks(view);
        const unprocessed = videos.filter(v => !task.processedIds.has(v.aid));

        if (unprocessed.length === 0) {
          scrollTry++;
          if (scrollTry > 10) { log('  没有更多视频'); break; }
          log(`  滚动加载 (${scrollTry}/10)...`);
          await human.mouseScroll(wc, 'down', 3);
          await wait(2000, 3000);
          continue;
        }
        scrollTry = 0;

        const v = unprocessed[0];
        count++;
        log(`\n━━━ [${count}/${target}] 视频 ${v.aid} ━━━`);

        // 先从列表检查评论数（不点击进入）
        const listCommentCount = await dom.getVideoCommentCountFromList(view, v.aid);
        if (listCommentCount === 0) {
          log('  ⏭ 列表显示0评论/抢首评，跳过');
          task.processedIds.add(v.aid);
          fails++;
          continue;
        }
        if (listCommentCount > 0) {
          log(`  📊 列表评论数: ${listCommentCount}`);
        }

        // 处理前就标记已处理（防止重复处理）
        task.processedIds.add(v.aid);

        // 处理视频（核心）
        const result = await videoProcessor.processVideo({
          view,
          aid: v.aid,
          keywords: { intent: intentKw, garbage: garbageKw },
          cdp,
          shouldContinue: () => searchRunning && !task.stopped,
          onResult,
          onLog: log,
          cutoffTs
        });

        if (result.skipped) {
          fails++;
          log(`  ⏭ 跳过: ${result.skipped}`);
          if (fails >= 3) {
            log('  ⚠️ 连续3次失败，检查验证码...');
            if (await dom.hasCaptcha(view)) {
              log('  ⚠️ 验证码！请手动完成');
              while (await dom.hasCaptcha(view) && searchRunning) await wait(3000);
            }
            fails = 0;
          }
          continue;
        }

        fails = 0;
        task.matchedTotal += result.matched;
        log(`  ✅ 完成: CDP:${result.cdp} DOM:${result.dom} 命中:${result.matched}`);

        // 随机暂停
        sincePause++;
        if (sincePause >= pauseAfter) {
          const sec = rand(15, 60);
          log(`⏸ 随机暂停 ${sec}s`);
          if (!await wait(sec * 1000)) break;
          sincePause = 0;
          pauseAfter = rand(1, 3);
        }
      }

      log(`━━━ 关键词 [${kw}] 完成 ━━━`);
    }

    log(`\n✅ 搜索完成！共 ${task.matchedTotal} 条意向`);
  } catch (e) {
    log(`❌ 搜索异常: ${e.message}`);
    logger.error(e.stack || e.message);
  } finally {
    searchRunning = false;
    searchPaused = false;
    currentTask = null;
    scheduler.notifySearchDone();
  }
}

// ========== 搜索操作 ==========

async function doSearch(view, keyword) {
  const wc = view.webContents;

  // 1. 点击搜索框获取焦点（精确坐标）
  const si = await dom.findSearchInput(view);
  if (!si) {
    log('  ❌ 搜索框未找到');
    return false;
  }
  log(`  搜索框: (${Math.round(si.x)},${Math.round(si.y)})`);

  // 用 executeJavaScript 直接聚焦搜索框（不依赖鼠标坐标）
  const focused = await js(wc, `(function(){
    const e = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
    if (!e) return false;
    e.focus();
    e.click();
    return true;
  })()`);

  if (!focused) {
    log('  ❌ 搜索框聚焦失败');
    return false;
  }
  await sleep(300, 500);

  // 2. 清空搜索框（模拟 Ctrl+A + Backspace）
  await js(wc, `(function(){
    const e = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
    if (e) { e.select(); }
  })()`);
  await sleep(100, 200);
  await human.keyPress(wc, 'Backspace');
  await sleep(200, 400);

  // 3. 用 insertText 输入（触发 React 事件）
  await wc.insertText(keyword);
  await sleep(500, 800);

  // 验证输入
  const val = await js(wc, `document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]')?.value || ''`);
  log(`  ✓ 输入: "${val}"`);

  // 4. 用 Enter 触发搜索（不用鼠标点击搜索按钮，避免误触视频）
  await human.keyPress(wc, 'Enter');
  log('  ✓ 按回车搜索');

  // 5. 等待跳转
  await sleep(6000, 8000);

  // 6. 验证 URL
  const url = await js(wc, 'location.href') || '';
  const isSearch = url.includes('search');

  if (!isSearch) {
    // 再试一次 Enter
    log('  搜索未生效，再按回车...');
    await human.keyPress(wc, 'Enter');
    await sleep(5000, 7000);
    const url2 = await js(wc, 'location.href') || '';
    if (url2.includes('search')) {
      log('  ✓ 回车重试成功');
      return true;
    }
    log(`  ❌ 搜索失败 (${url2.substring(0, 50)})`);
    return false;
  }

  log('  ✓ 搜索页');

  // 验证码检查
  if (await dom.hasCaptcha(view)) {
    log('  ⚠️ 验证码！');
    while (await dom.hasCaptcha(view) && searchRunning) await sleep(3000);
  }

  return true;
}

// ========== 筛选 ==========

async function doFilter(view, params) {
  const wc = view.webContents;
  const fp = await findText(view, '筛选');
  if (!fp) { log('  ❌ 筛选未找到'); return; }

  // 悬停打开筛选面板
  await human.mouseHover(wc, fp.x, fp.y, 50, 20, 2000);
  await sleep(2000, 2500);

  // 选择排序
  const sortMap = { likes: '最多点赞', newest: '最新发布' };
  if (params.sortMode && sortMap[params.sortMode]) {
    const p = await findTextContains(view, sortMap[params.sortMode]);
    if (p) {
      await human.mouseClick(wc, p.x, p.y);
      log(`  ✓ 排序: ${sortMap[params.sortMode]}`);
      await sleep(1500, 2500);
    } else {
      log(`  ⚠ 排序选项未找到: ${sortMap[params.sortMode]}`);
    }
  }

  // 选择时间
  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (params.filterTime && timeMap[params.filterTime]) {
    const p = await findTextContains(view, timeMap[params.filterTime]);
    if (p) {
      await human.mouseClick(wc, p.x, p.y);
      log(`  ✓ 时间: ${timeMap[params.filterTime]}`);
      await sleep(1500, 2500);
    } else {
      log(`  ⚠ 时间选项未找到: ${timeMap[params.filterTime]}`);
    }
  }

  // 点击筛选按钮关闭面板
  await human.mouseClick(wc, fp.x, fp.y);
  log('  ✓ 筛选已应用');
  await sleep(2000, 3000);
}

// ========== 工具 ==========

async function checkLogin(wc) {
  const body = await js(wc, 'document.body.innerText.substring(0,300)') || '';
  if (!body.includes('登录') || body.length > 100) return true;

  log('  等待登录...');
  for (let i = 0; i < 120; i++) {
    if (!searchRunning) return false;
    await wait(3000);
    const b = await js(wc, 'document.body.innerText.substring(0,300)') || '';
    if (!b.includes('登录') || b.length > 100) return true;
  }
  return false;
}

async function findText(view, text) {
  return await js(view.webContents, `(function(){
    for(const el of document.querySelectorAll('*')){
      const t=(el.innerText||'').trim();
      if(t==='${text.replace(/'/g,"\\'")}'){
        const r=el.getBoundingClientRect();
        if(r.width>10&&r.height>10&&r.height<50&&r.y<200&&r.y>30)
          return{x:r.x+r.width/2,y:r.y+r.height/2};
      }
    }
    return null;
  })()`);
}

async function findTextContains(view, text) {
  return await js(view.webContents, `(function(){
    for(const el of document.querySelectorAll('*')){
      const t=(el.innerText||'').trim();
      if(t.includes('${text.replace(/'/g,"\\\'")}')){
        const r=el.getBoundingClientRect();
        if(r.width>10&&r.height>10&&r.height<60&&r.y>30&&r.y<300)
          return{x:r.x+r.width/2,y:r.y+r.height/2};
      }
    }
    return null;
  })()`);
}

async function js(wc, s) {
  try { return await wc.executeJavaScript(s); } catch(_) { return null; }
}

function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }
function sleep(a, b) { const ms = b ? rand(a,b) : a; return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random()*(b-a)+a); }

module.exports = { startSearch, stopSearch, pauseSearch, isRunning, isPaused };
