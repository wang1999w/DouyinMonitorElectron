/**
 * 小红书搜索引擎
 *
 * 流程：搜索关键词 → 扫描笔记链接 → 逐个处理笔记（评论采集+关键词匹配）
 * 暂不做自动化操作，仅支持手动触发搜索
 */

const dom = require('./domUtils-xhs');
const noteProcessor = require('./noteProcessor');
const human = require('./humanBehavior');
const { getLogger } = require('./logger');

const logger = getLogger('XHS-Search');

let searchRunning = false;
let searchPaused = false;
let logCallback = null;
let currentTask = null;

function isRunning() { return searchRunning; }
function isPaused() { return searchPaused; }

function stopSearch() {
  searchRunning = false;
  searchPaused = false;
  if (currentTask) currentTask.stopped = true;
  log('🛑 小红书搜索已停止');
}

function pauseSearch() {
  if (!searchRunning) return;
  searchPaused = !searchPaused;
  log(searchPaused ? '⏸ 暂停' : '▶ 继续');
}

async function startSearch(params, onLog, onResult, onProgress, getViewFn, getCdpFn) {
  if (searchRunning) return;
  searchRunning = true;
  searchPaused = false;
  logCallback = onLog;

  if (!params.keywords) {
    params.keywords = params.keyword ? (Array.isArray(params.keyword) ? params.keyword : [params.keyword]) : [];
  } else if (typeof params.keywords === 'string') {
    params.keywords = [params.keywords];
  }

  const task = { params, processedIds: new Set(), stopped: false, matchedTotal: 0 };
  currentTask = task;

  log(`🚀 启动小红书搜索 关键词: ${params.keywords.join(', ')}`);

  try {
    const view = getViewFn();
    if (!view || !view.webContents) { log('❌ 浏览器未就绪'); return; }
    const wc = view.webContents;
    const cdp = getCdpFn();

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.xhs_search_intent_keywords || cfg.search_intent_keywords || [];
    const garbageKw = cfg.xhs_search_garbage_keywords || cfg.search_garbage_keywords || [];
    const keywords = params.keywords || [];
    // 评论时效（小时）：默认1小时=60分钟，与其他模块一致；严格按时间戳过滤
    const commentHours = params.commentHours || 1;
    const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 3600;

    // 合并筛选参数（优先使用params，降级到config配置）
    const filterParams = {
      sortMode: params.sortMode || cfg.xhs_search_sort_mode || 'default',
      noteType: params.noteType || cfg.xhs_search_note_type || '不限',
      filterTime: String(params.filterTime || cfg.xhs_search_filter_time || '0'),
      searchScope: params.searchScope || cfg.xhs_search_scope || '不限',
      location: params.location || cfg.xhs_search_location || '不限',
    };

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!searchRunning) break;
      // 暂停检查
      while (searchPaused && searchRunning) { await sleep(300); }
      if (!searchRunning) break;

      const kw = keywords[kwIdx];
      log(`\n━━━ [${kwIdx+1}/${keywords.length}] ${kw} ━━━`);

      // 搜索
      const searchOk = await doSearch(view, kw);
      if (!searchOk) { log('❌ 搜索失败'); continue; }

      await dom.sleep(3000, 5000);

      // 筛选（在跳过AI区域前应用筛选）
      await doFilter(view, filterParams);

      // 跳过点点AI区域，滚动到笔记列表开始位置
      await skipAIArea(view, wc, log);

      // 笔记循环
      const target = params.maxNotes || params.maxVideos || 10;
      let count = 0, scrollTry = 0;

      while (searchRunning && count < target) {
        // 暂停检查
        while (searchPaused && searchRunning) { await sleep(300); }
        if (!searchRunning) break;

        const notes = await dom.scanNoteLinks(view);
        const unprocessed = notes.filter(n => !task.processedIds.has(n.noteId));

        if (unprocessed.length === 0) {
          scrollTry++;
          if (scrollTry > 10) { log('无更多笔记'); break; }
          log(`滚动加载 ${scrollTry}/10...`);
          await human.mouseScroll(wc, 'down', 3);
          await dom.sleep(2000, 3000);
          continue;
        }
        scrollTry = 0;

        const n = unprocessed[0];
        task.processedIds.add(n.noteId);
        count++;
        log(`[${count}/${target}] 笔记 ${n.noteId} "${(n.title || '').slice(0, 20)}"`);

        // 模拟人类浏览笔记列表时的停顿（看到感兴趣的笔记会先看一眼）
        await human.humanPause(wc, human.rand(1000, 3000));

        const result = await noteProcessor.processNote({
          view, noteId: n.noteId,
          keywords: { intent: intentKw, garbage: garbageKw },
          cdp,
          shouldContinue: () => searchRunning && !task.stopped,
          onResult,
          onLog: log,
          maxComments: params.maxComments || 200,
          onProgress: (info) => {
            if (typeof onProgress === 'function') {
              try {
                onProgress({ ...info, videoIndex: count, videoTotal: target, matchedTotal: task.matchedTotal });
              } catch (_) {}
            }
          },
          cutoffTs,
          videoInfo: {
            note_id: n.noteId,
            title: n.title || '',
            author: n.author || '',
            author_url: n.authorUrl || '',
            note_url: 'https://www.xiaohongshu.com/explore/' + n.noteId
          }
        });

        if (result.skipped) { log(`  跳过: ${result.skipped}`); }
        else { task.matchedTotal += result.matched; log(`  ✅ 命中:${result.matched}`); }

        // 笔记间间隔（模拟人类浏览间隔，鼠标轻微移动）
        await human.humanPause(wc, 2000);
      }
    }

    log(`✅ 完成！共 ${task.matchedTotal} 条意向`);
  } catch (e) {
    log(`❌ 搜索异常: ${e.message}`);
    logger.error(`小红书搜索异常: ${e.stack || e.message}`);
  } finally {
    searchRunning = false;
    searchPaused = false;
    currentTask = null;
  }
}

async function doSearch(view, keyword) {
  const wc = view.webContents;

  // 确保在小红书页面
  const currentUrl = await dom.execJS(wc, 'location.href') || '';
  if (!currentUrl.includes('xiaohongshu.com')) {
    await wc.loadURL('https://www.xiaohongshu.com');
    await dom.sleep(3000, 5000);
    await human.humanPause(wc, human.rand(1500, 3000));
  }

  // 找到搜索框位置，先做一次真实点击（聚焦 + 模拟人类行为）
  const searchInput = await dom.findSearchInput(view);
  if (!searchInput) { log('  - not found search box'); return false; }
  log('  - click search box at (' + searchInput.x + ',' + searchInput.y + ')');
  await human.humanClick(wc, searchInput.x, searchInput.y);
  await dom.sleep(500, 1000);

  // JS注入：聚焦 + 清空搜索框（React感知）
  await dom.execJS(wc, '(function(){var cs=document.querySelectorAll(\'textarea, input\');var t=null;for(var i=0;i<cs.length;i++){var r=cs[i].getBoundingClientRect();if(r.width>50&&r.height>10){t=cs[i];break;}}if(!t)return false;try{t.focus();t.value=\'\';t.dispatchEvent(new Event(\'input\',{bubbles:true}));}catch(e){return false;}return true;})()');
  await dom.sleep(200, 400);

  // 设置关键词（使用 value setter + input/change 事件确保 React 感知）
  log('  - set keyword: ' + keyword);
  let kwSafe = keyword;
  try { kwSafe = keyword.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/\r?\n/g, ''); } catch(e) {}
  const setKwScript = '(function(){var cs=document.querySelectorAll(\'textarea, input\');var t=null;for(var i=0;i<cs.length;i++){var r=cs[i].getBoundingClientRect();if(r.width>50&&r.height>10){t=cs[i];break;}}if(!t)return false;try{t.focus();}catch(e){}var kw=\"' + kwSafe + '\";try{var proto=t.tagName===\'TEXTAREA\'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var setter=Object.getOwnPropertyDescriptor(proto,\'value\').set;setter.call(t,kw);}catch(e){t.value=kw;}try{t.dispatchEvent(new Event(\'input\',{bubbles:true}));t.dispatchEvent(new Event(\'change\',{bubbles:true}));}catch(e){}return true;})()';
  let setOk = false;
  try { setOk = await dom.execJS(wc, setKwScript); } catch(e) { log('  - execJS err: ' + e.message); }
  if (!setOk) {
    log('  - JS set failed, use dom.setSearchInputValue fallback');
    await dom.setSearchInputValue(view, keyword);
  }
  await dom.sleep(300, 600);

  // ===== 触发搜索：4 层 fallback ===== 

  // 方式1：sendInputEvent 发送 Enter 键
  log('  - try press Enter (sendInputEvent)');
  await human.keyPress(wc, 'Enter');
  await dom.sleep(3000, 5000);
  let url = await dom.execJS(wc, 'location.href') || '';
  if (url.includes('search_result') || url.includes('search')) { log('  + loaded (Enter)'); return true; }

  // 方式2：JS 注入键盘事件（对 React/Vue 更可靠）
  log('  - try JS keyboard event injection');
  await dom.execJS(wc, '(function(){var cs=document.querySelectorAll(\'textarea, input\');var t=null;for(var i=0;i<cs.length;i++){var r=cs[i].getBoundingClientRect();if(r.width>50&&r.height>10){t=cs[i];break;}}if(!t)t=document.body;try{t.focus();}catch(e){}var opts={key:\'Enter\',code:\'Enter\',keyCode:13,which:13,bubbles:true,cancelable:true};var ok=false;try{t.dispatchEvent(new KeyboardEvent(\'keydown\',opts));ok=true;}catch(e){}try{t.dispatchEvent(new KeyboardEvent(\'keypress\',opts));ok=true;}catch(e){}try{t.dispatchEvent(new KeyboardEvent(\'keyup\',opts));ok=true;}catch(e){}return ok;})()');
  await dom.sleep(3000, 5000);
  url = await dom.execJS(wc, 'location.href') || '';
  if (url.includes('search_result') || url.includes('search')) { log('  + loaded (JS)'); return true; }

  // 方式3：点击搜索图标
  log('  - try click search icon');
  const searchBtn = await dom.findSearchButton(view);
  if (searchBtn) {
    log('  - click (' + searchBtn.x + ',' + searchBtn.y + ')');
    await human.humanClick(wc, searchBtn.x, searchBtn.y);
    await dom.sleep(3000, 5000);
    url = await dom.execJS(wc, 'location.href') || '';
    if (url.includes('search_result') || url.includes('search')) { log('  + loaded (click)'); return true; }
  }

  // 方式4：终极 fallback - 直接 loadURL 跳转搜索结果页
  log('  - all modes failed, direct URL load fallback');
  await dom.loadSearchURL(view, keyword);
  await dom.sleep(3000, 5000);
  url = await dom.execJS(wc, 'location.href') || '';
  if (url.includes('search_result') || url.includes('search')) { log('  + loaded (URL)'); return true; }

  log('  - search FAILED (url=' + url + ')');
  return false;
}

async function skipAIArea(view, wc, log) {
  try {
    // 探测页面结构：查找点点AI区域和第一个笔记的位置
    const info = await dom.execJS(wc, `(function(){
      var result = { hasAIArea: false, aiAreaY: 0, aiAreaH: 0, firstNoteY: 0, scrollY: window.scrollY };

      // 查找可见的点点AI区域（多种可能的选择器）
      var aiSelectors = [
        '.xhs-ai-chat', '[class*="ai-chat"]', '[class*="AiChat"]',
        '[class*="ai-answer"]', '[class*="search-ai"]',
        '.search-layout__ai', '.ai-search-result',
        '[class*="summarize"]', '[class*="answer-card"]',
        '[class*="ai-layout"]', '[class*="ai-layout-active"]',
        '[class*="AiLayout"]', '[class*="ai-container"]'
      ];
      for (var i = 0; i < aiSelectors.length; i++) {
        var els = document.querySelectorAll(aiSelectors[i]);
        for (var j = 0; j < els.length; j++) {
          var r = els[j].getBoundingClientRect();
          if (r.width > 200 && r.height > 100) {
            result.hasAIArea = true;
            result.aiAreaY = Math.round(r.y);
            result.aiAreaH = Math.round(r.height);
            break;
          }
        }
        if (result.hasAIArea) break;
      }

      // 查找第一个可见的笔记
      var notes = document.querySelectorAll('section.note-item');
      for (var k = 0; k < notes.length; k++) {
        var nr = notes[k].getBoundingClientRect();
        if (nr.width > 50 && nr.height > 50) {
          result.firstNoteY = Math.round(nr.y);
          break;
        }
      }

      return result;
    })()`);

    if (!info) {
      log('  跳过AI区域：无法获取页面信息');
      return;
    }

    if (info.hasAIArea && info.aiAreaH > 100) {
      log(`  检测到点点AI区域 (y=${info.aiAreaY}, h=${info.aiAreaH})，设置点击穿透...`);
      // 只设置 pointer-events: none，不修改高度/显示（避免子元素 note-item 被隐藏）
      await dom.execJS(wc, `(function(){
        var aiSelectors = ['[class*="ai-layout"]', '[class*="ai-chat"]', '[class*="AiChat"]', '[class*="ai-answer"]', '[class*="search-ai"]', '.ai-search-result', '[class*="summarize"]', '[class*="answer-card"]', '[class*="ai-container"]'];
        for (var i = 0; i < aiSelectors.length; i++) {
          var els = document.querySelectorAll(aiSelectors[i]);
          for (var j = 0; j < els.length; j++) {
            var r = els[j].getBoundingClientRect();
            if (r.width > 200 && r.height > 100) {
              els[j].style.pointerEvents = 'none';
            }
          }
        }
      })()`);
      await dom.sleep(300);
      // 滚动到第一个笔记位置
      if (info.firstNoteY > 0) {
        log(`  滚动到笔记列表 (第一个笔记y=${info.firstNoteY})...`);
        await human.mouseScroll(wc, 'down', Math.ceil(info.firstNoteY / 300));
      } else {
        await human.mouseScroll(wc, 'down', 3);
      }
      await dom.sleep(1500, 2500);
      log('  ✓ 已跳过点点AI区域');
    } else {
      // 没有AI区域，但确保滚动到第一个笔记可见位置
      if (info.firstNoteY > 300) {
        log(`  滚动到笔记列表 (第一个笔记y=${info.firstNoteY})...`);
        await human.mouseScroll(wc, 'down', Math.ceil(info.firstNoteY / 300));
        await dom.sleep(1000, 2000);
      }
    }
  } catch (e) {
    log(`  跳过AI区域异常: ${e.message}`);
  }
}

// ========== 小红书筛选功能 ==========
// 小红书筛选按钮：div.filter (x=722, y=88)
// 触发方式：鼠标悬停（mouseenter），不是点击
// 面板：div.filter-panel (x=458, y=136, w=360, h=565)
// 选项：div.tags（未选中）/ div.tags.active（选中）
// 关键：鼠标不能离开面板区域，否则面板自动关闭
//
// 筛选选项映射：
//   排序：综合/最新/最多点赞/最多评论/最多收藏
//   笔记类型：不限/视频/图文
//   发布时间：不限/一天内/一周内/半年内
//   搜索范围：不限/已看过/未看过/已关注
//   位置距离：不限/同城/附近

async function doFilter(view, params) {
  const wc = view.webContents;

  // 检查是否需要筛选
  const needSort = params.sortMode && params.sortMode !== 'default' && params.sortMode !== '综合';
  const needNoteType = params.noteType && params.noteType !== '不限';
  const needFilterTime = params.filterTime && params.filterTime !== '0';
  const needSearchScope = params.searchScope && params.searchScope !== '不限';
  const needLocation = params.location && params.location !== '不限';

  if (!needSort && !needNoteType && !needFilterTime && !needSearchScope && !needLocation) {
    return; // 不需要筛选
  }

  log('  开始筛选...');

  // 1. 定位筛选按钮
  const filterBtn = await dom.execJS(wc, `(function(){
    var e = document.querySelector('div.filter');
    if (!e) return null;
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (!filterBtn) {
    log('  ⚠ 筛选按钮未找到');
    return;
  }
  log(`  ✓ 筛选按钮 @(${filterBtn.x},${filterBtn.y})`);

  // 2. 悬停打开面板（用CDP的Input.dispatchMouseEvent模拟真实鼠标移动）
  // 小红书是hover触发，必须用真实鼠标事件
  // 先移动到筛选按钮附近（避免Bezier曲线绕过按钮）
  await human.mouseMove(wc, filterBtn.x - 30, filterBtn.y);
  await dom.sleep(200, 400);
  // 再缓慢移动到按钮中心
  await human.mouseMove(wc, filterBtn.x, filterBtn.y);
  await dom.sleep(1000, 1500); // 悬停等待面板展开

  // 验证面板是否出现
  let panel = await _getFilterPanel(wc);
  if (!panel) {
    log('  ⚠ 筛选面板未出现，重试悬停...');
    // 再悬停一次：先移开再移回
    await human.mouseMove(wc, filterBtn.x - 50, filterBtn.y - 30);
    await dom.sleep(300, 500);
    await human.mouseMove(wc, filterBtn.x - 10, filterBtn.y);
    await dom.sleep(200, 400);
    await human.mouseMove(wc, filterBtn.x, filterBtn.y);
    await dom.sleep(1000, 1500);
    panel = await _getFilterPanel(wc);
    if (!panel) {
      log('  ❌ 筛选面板未出现');
      return;
    }
  }
  log(`  ✓ 筛选面板已展开 @(${panel.x},${panel.y},${panel.w}x${panel.h})`);

  // 3. 在面板内选择选项（鼠标必须在面板内移动）
  // 排序
  const sortMap = {
    'newest': '最新',
    'likes': '最多点赞',
    'comments': '最多评论',
    'collects': '最多收藏',
    'comprehensive': '综合'
  };
  if (needSort && sortMap[params.sortMode]) {
    const r = await _clickFilterOption(wc, sortMap[params.sortMode], panel);
    if (r) log(`  ✓ 排序: ${sortMap[params.sortMode]} @(${r.x},${r.y})`);
    else log(`  ❌ 排序未找到: ${sortMap[params.sortMode]}`);
    await dom.sleep(800, 1500);
  }

  // 笔记类型
  if (needNoteType) {
    const r = await _clickFilterOption(wc, params.noteType, panel);
    if (r) log(`  ✓ 笔记类型: ${params.noteType} @(${r.x},${r.y})`);
    else log(`  ❌ 笔记类型未找到: ${params.noteType}`);
    await dom.sleep(800, 1500);
  }

  // 发布时间
  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (needFilterTime && timeMap[params.filterTime]) {
    const r = await _clickFilterOption(wc, timeMap[params.filterTime], panel);
    if (r) log(`  ✓ 发布时间: ${timeMap[params.filterTime]} @(${r.x},${r.y})`);
    else log(`  ❌ 发布时间未找到: ${timeMap[params.filterTime]}`);
    await dom.sleep(800, 1500);
  }

  // 搜索范围
  if (needSearchScope) {
    const r = await _clickFilterOption(wc, params.searchScope, panel);
    if (r) log(`  ✓ 搜索范围: ${params.searchScope} @(${r.x},${r.y})`);
    else log(`  ❌ 搜索范围未找到: ${params.searchScope}`);
    await dom.sleep(800, 1500);
  }

  // 位置距离
  if (needLocation) {
    const r = await _clickFilterOption(wc, params.location, panel);
    if (r) log(`  ✓ 位置距离: ${params.location} @(${r.x},${r.y})`);
    else log(`  ❌ 位置距离未找到: ${params.location}`);
    await dom.sleep(800, 1500);
  }

  // 4. 点击"收起"按钮关闭面板
  const collapseBtn = await _findFilterButton(wc, '收起', panel);
  if (collapseBtn) {
    // 鼠标移动到收起按钮（保持在面板内）
    await human.mouseMove(wc, collapseBtn.x, collapseBtn.y);
    await dom.sleep(200, 400);
    await human.humanClick(wc, collapseBtn.x, collapseBtn.y);
    log('  ✓ 已点击收起按钮关闭面板');
  } else {
    // 降级：鼠标移开面板触发关闭
    await human.mouseMove(wc, 200, 200);
    log('  ✓ 鼠标移开关闭面板');
  }
  await dom.sleep(1500, 2500);
  log('  ✓ 筛选已应用');
}

// 获取筛选面板信息
async function _getFilterPanel(wc) {
  return await dom.execJS(wc, `(function(){
    var e = document.querySelector('div.filter-panel');
    if (!e) return null;
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
}

// 在筛选面板内查找并点击指定选项
// 关键：鼠标移动路径必须保持在面板内
async function _clickFilterOption(wc, text, panel) {
  // 先在面板内查找选项位置
  const item = await dom.execJS(wc, `(function(){
    var panel = document.querySelector('div.filter-panel');
    if (!panel) return null;
    var tags = panel.querySelectorAll('div.tags');
    for (var i = 0; i < tags.length; i++) {
      var t = (tags[i].innerText || '').trim();
      if (t === '${text.replace(/'/g, "\\'")}') {
        var r = tags[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
        }
      }
    }
    return null;
  })()`);
  if (!item) return null;

  // 鼠标从当前位置移动到选项位置（保持在面板内）
  // 用mouseMove直接移动（humanBehavior的mouseMove使用Bezier曲线，可能离开面板）
  // 这里用直线移动确保不离开面板
  await wc.sendInputEvent({ type: 'mouseMove', x: Math.round(item.x), y: Math.round(item.y) });
  await dom.sleep(300, 600);
  // 点击
  await human.humanClick(wc, item.x, item.y);
  return item;
}

// 在筛选面板内查找操作按钮（重置/收起）
async function _findFilterButton(wc, text, panel) {
  return await dom.execJS(wc, `(function(){
    var panel = document.querySelector('div.filter-panel');
    if (!panel) return null;
    var btns = panel.querySelectorAll('div.operation, button, [class*="btn"]');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].innerText || '').trim();
      if (t === '${text.replace(/'/g, "\\'")}') {
        var r = btns[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
        }
      }
    }
    return null;
  })()`);
}

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { startSearch, stopSearch, pauseSearch, isRunning, isPaused };
