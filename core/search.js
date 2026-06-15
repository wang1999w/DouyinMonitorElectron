/**
 * 搜索引擎（完全重写版）
 *
 * 核心原则：
 *   1. 每步操作后验证结果
 *   2. 暂停/停止随时响应
 *   3. 不盲目重试
 *   4. 日志清晰记录每步状态
 */

const { getDouyinView } = require('../main/window');
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
function isRunning() { return searchRunning; }
function isPaused() { return searchPaused; }

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

// ========== 可中断等待 ==========

async function wait(ms) {
  const step = 300;
  for (let t = 0; t < ms; t += step) {
    if (!searchRunning) return false;
    if (searchPaused) {
      log('⏸ 已暂停');
      while (searchPaused) { await sleep(300); if (!searchRunning) return false; }
      log('▶ 已恢复');
    }
    await sleep(step);
  }
  return true;
}

// ========== 主流程 ==========

async function startSearch(params, onLog, onResult) {
  if (searchRunning) return;
  searchRunning = true;
  searchPaused = false;
  logCallback = onLog;

  const task = { params, processedIds: new Set(), stopped: false, matchedTotal: 0 };
  currentTask = task;
  scheduler.registerSearch(params);

  const isQuantityMode = params.sortEnabled;
  log(`🚀 启动 [${isQuantityMode ? '数量' : '时间'}模式] 关键词: ${params.keywords.join(', ')}`);

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('❌ 浏览器未就绪'); return; }
    const wc = view.webContents;

    // 检查登录
    const body = await js(wc, 'document.body.innerText.substring(0,300)') || '';
    if (body.includes('登录') && body.length < 100) {
      log('请登录抖音...');
      for (let i = 0; i < 120; i++) {
        if (!await wait(3000)) return;
        const b = await js(wc, 'document.body.innerText.substring(0,300)') || '';
        if (!b.includes('登录') || b.length > 100) { log('✅ 登录成功'); break; }
      }
    }

    // 检查验证码
    if (await dom.hasCaptcha(view)) {
      log('⚠️ 验证码！请手动完成');
      while (await dom.hasCaptcha(view) && searchRunning) await wait(3000);
      log('✅ 验证码已通过');
    }

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const keywords = params.keywords || [];
    const commentHours = params.commentHours || 60;
    const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 60;
    const cdp = require('./cdpInterceptor');

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!searchRunning) break;
      const kw = keywords[kwIdx];
      log(`\n━━━ [${kwIdx+1}/${keywords.length}] ${kw} ━━━`);

      // 搜索
      const searchOk = await doSearch(view, kw);
      if (!searchOk) { log('❌ 搜索失败'); continue; }

      // 切换视频标签
      log('切换视频标签...');
      await clickTab(view, '视频');
      await wait(2000, 3000);

      // 筛选
      if (isQuantityMode && (params.sortMode !== 'default' || params.filterTime !== '0')) {
        log('筛选...');
        await doFilter(view, params);
      }

      // 视频循环
      const target = isQuantityMode ? (params.maxVideos || 10) : 999;
      let count = 0, fails = 0, scrollTry = 0, sincePause = 0, pauseAfter = rand(1, 3);

      while (searchRunning && count < target) {
        const videos = await dom.scanVideoLinks(view);
        const unprocessed = videos.filter(v => !task.processedIds.has(v.aid));

        if (unprocessed.length === 0) {
          scrollTry++;
          if (scrollTry > 10) { log('无更多视频'); break; }
          log(`滚动加载 ${scrollTry}/10...`);
          await human.mouseScroll(wc, 'down', 3);
          await wait(2000, 3000);
          continue;
        }
        scrollTry = 0;

        const v = unprocessed[0];
        task.processedIds.add(v.aid);
        count++;
        log(`[${count}/${target}] 视频 ${v.aid}`);

        const result = await videoProcessor.processVideo({
          view, aid: v.aid,
          keywords: { intent: intentKw, garbage: garbageKw },
          cdp,
          shouldContinue: () => searchRunning && !task.stopped,
          onResult,
          onLog: log,
          cutoffTs
        });

        if (result.skipped) { fails++; log(`  跳过: ${result.skipped}`); }
        else { fails = 0; task.matchedTotal += result.matched; log(`  ✅ 命中:${result.matched}`); }

        if (fails >= 3) {
          fails = 0;
          if (await dom.hasCaptcha(view)) {
            log('⚠️ 验证码！请手动完成');
            while (await dom.hasCaptcha(view) && searchRunning) await wait(3000);
          }
        }

        // 随机暂停
        sincePause++;
        if (sincePause >= pauseAfter) {
          const sec = rand(15, 60);
          log(`⏸ 暂停 ${sec}s`);
          if (!await wait(sec * 1000)) break;
          sincePause = 0;
          pauseAfter = rand(1, 3);
        }
      }
    }

    log(`✅ 完成！共 ${task.matchedTotal} 条意向`);
  } catch (e) {
    log(`❌ 异常: ${e.message}`);
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

  // 用 JS 直接聚焦搜索框
  const focused = await js(wc, `(function(){
    const e = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
    if (!e) return false;
    e.focus(); e.click(); return true;
  })()`);

  if (!focused) { log('  ❌ 搜索框未找到'); return false; }
  await sleep(300, 500);

  // 清空
  await js(wc, `(function(){
    const e = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
    if (e) e.select();
  })()`);
  await sleep(100, 200);
  await human.keyPress(wc, 'Backspace');
  await sleep(200, 400);

  // insertText 输入
  await wc.insertText(keyword);
  await sleep(500, 800);
  log(`  ✓ 输入: ${keyword}`);

  // Enter 搜索
  await human.keyPress(wc, 'Enter');
  await sleep(6000, 8000);

  // 验证
  const url = await js(wc, 'location.href') || '';
  if (!url.includes('search')) {
    log('  搜索未生效，回车重试...');
    await human.keyPress(wc, 'Enter');
    await sleep(5000, 7000);
    const url2 = await js(wc, 'location.href') || '';
    if (!url2.includes('search')) { log(`  ❌ 失败`); return false; }
  }
  log('  ✓ 搜索页');

  if (await dom.hasCaptcha(view)) {
    log('  ⚠️ 验证码！');
    while (await dom.hasCaptcha(view) && searchRunning) await wait(3000);
  }
  return true;
}

// ========== 点击标签 ==========

async function clickTab(view, tabName) {
  const wc = view.webContents;
  const pos = await js(wc, `(function(){
    // 精确匹配标签文本
    const tabs = document.querySelectorAll('[class*="tab"], [role="tab"], a, button, span, div');
    for (const el of tabs) {
      const t = (el.innerText || '').trim();
      if (t !== '${tabName}') continue;
      const r = el.getBoundingClientRect();
      // 标签通常在页面顶部，宽度适中
      if (r.width > 10 && r.width < 200 && r.height > 10 && r.height < 50 && r.y > 30 && r.y < 200) {
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
    }
    return null;
  })()`);
  if (pos) {
    await human.mouseClick(wc, pos.x, pos.y);
    log(`  ✓ 点击: ${tabName}`);
  } else {
    log(`  ⚠ 未找到: ${tabName}`);
  }
}

// ========== 筛选 ==========

async function doFilter(view, params) {
  const wc = view.webContents;

  // 找筛选按钮
  const fp = await js(wc, `(function(){
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText||'').trim();
      if (t.includes('筛选') && t.length < 10) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.width < 120 && r.y > 30 && r.y < 300)
          return { x: r.x+r.width/2, y: r.y+r.height/2 };
      }
    }
    return null;
  })()`);
  if (!fp) { log('  ⚠ 筛选未找到'); return; }

  // 悬停打开
  await human.mouseHover(wc, fp.x, fp.y, 50, 20, 2000);
  await sleep(2000, 2500);

  // 选择排序（模糊匹配）
  const sortMap = { likes: '最多点赞', newest: '最新发布' };
  if (params.sortMode && sortMap[params.sortMode]) {
    const p = await js(wc, `(function(){
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText||'').trim();
        if (t.includes('${sortMap[params.sortMode]}')) {
          const r = el.getBoundingClientRect();
          if (r.width > 10 && r.height > 10 && r.height < 60 && r.y > 50)
            return { x: r.x+r.width/2, y: r.y+r.height/2 };
        }
      }
      return null;
    })()`);
    if (p) { await human.mouseClick(wc, p.x, p.y); log(`  ✓ 排序: ${sortMap[params.sortMode]}`); }
    else { log(`  ⚠ 排序未找到: ${sortMap[params.sortMode]}`); }
    await sleep(1500, 2500);
  }

  // 选择时间（模糊匹配）
  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (params.filterTime && timeMap[params.filterTime]) {
    const p = await js(wc, `(function(){
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText||'').trim();
        if (t.includes('${timeMap[params.filterTime]}')) {
          const r = el.getBoundingClientRect();
          if (r.width > 10 && r.height > 10 && r.height < 60 && r.y > 50)
            return { x: r.x+r.width/2, y: r.y+r.height/2 };
        }
      }
      return null;
    })()`);
    if (p) { await human.mouseClick(wc, p.x, p.y); log(`  ✓ 时间: ${timeMap[params.filterTime]}`); }
    else { log(`  ⚠ 时间未找到: ${timeMap[params.filterTime]}`); }
    await sleep(1500, 2500);
  }

  // 关闭筛选面板
  await human.mouseClick(wc, fp.x, fp.y);
  log('  ✓ 筛选已应用');
  await sleep(2000, 3000);
}

// ========== 工具 ==========

async function js(wc, s) { try { return await wc.executeJavaScript(s); } catch(_) { return null; } }
function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }
function sleep(a, b) { const ms = b ? rand(a, b) : a; return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

module.exports = { startSearch, stopSearch, pauseSearch, isRunning, isPaused };
