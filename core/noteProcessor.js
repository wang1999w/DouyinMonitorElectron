/**
 * 小红书笔记处理流程
 *
 * 对标抖音的 videoProcessor，处理单个笔记的评论采集
 * 流程：点击笔记 → 模拟阅读 → 滚动评论 → 采集评论 → 匹配关键词 → 关闭弹窗
 *
 * 人类行为模拟要点（对标抖音模块）：
 *   - 进入笔记后模拟"阅读"行为（鼠标移动、偶尔滚动）
 *   - 评论滚动交替使用鼠标滚轮和键盘ArrowDown
 *   - 滚动过程中添加"阅读停顿"（20%概率暂停2-5秒）
 *   - 时效判断：连续5条过期评论提前终止滚动
 *   - 关闭弹窗后模拟"浏览"行为
 */

const dom = require('./domUtils-xhs');
const pipeline = require('./pipeline');
const { getLogger } = require('./logger');
const human = require('./humanBehavior');

const logger = getLogger('NoteProcessor');

// 连续过期评论阈值（与抖音模块一致）
const EXPIRED_THRESHOLD = 5;

/**
 * 处理单个笔记的评论采集
 * @param {Object} options
 * @returns {Object} { matched, cdp, dom, skipped }
 */
async function processNote(options) {
  const {
    view, noteId, keywords, cdp,
    shouldContinue, onResult, onLog, onProgress,
    maxComments = 200, cutoffTs = 0, videoInfo
  } = options;

  const wc = view.webContents;
  const log = (msg) => { logger.info(msg); if (onLog) onLog(msg); };
  const stats = { matched: 0, cdp: 0, dom: 0, skipped: null };

  if (!shouldContinue || !shouldContinue()) return stats;

  // 1. CDP 开始采集
  if (cdp) cdp.beginCollect(noteId);

  // 2. 点击笔记进入详情（使用模拟鼠标点击，避免被检测）
  const pos = await dom.clickNoteById(view, noteId);
  log(`  clickNoteById结果: ${JSON.stringify(pos)}`);
  if (!pos) {
    log(`  clickNoteById未找到可见链接，用JS触发note-item点击...`);
    // 不导航到 /explore/{noteId}（会导致页面回到首页），而是用 JS 触发 note-item 的 click 事件
    const clicked = await dom.execJS(wc, `(function(){
      // 查找包含 noteId 的 section.note-item
      var items = document.querySelectorAll('section.note-item');
      for (var i = 0; i < items.length; i++) {
        var links = items[i].querySelectorAll('a');
        for (var j = 0; j < links.length; j++) {
          var href = links[j].getAttribute('href') || '';
          if (href.indexOf('${noteId}') !== -1) {
            // 滚动到该 note-item
            items[i].scrollIntoView({ block: 'center' });
            // 触发 click 事件（用 dispatchEvent 而不是 a.click()，避免页面导航）
            var ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            links[j].dispatchEvent(ev);
            return true;
          }
        }
      }
      return false;
    })()`);
    if (!clicked) {
      log(`  JS触发点击也失败，尝试导航: ${noteId}`);
      try {
        await view.webContents.loadURL('https://www.xiaohongshu.com/explore/' + noteId);
      } catch (e) {
        stats.skipped = '导航失败';
        if (cdp) cdp.endCollect(noteId);
        return stats;
      }
    }
    await dom.sleep(2000, 3000);
  } else {
    // 使用模拟人类点击（Bezier曲线移动+悬停+点击）
    await human.humanClick(wc, pos.x, pos.y);
  }

  // 等待SPA导航完成或详情弹窗出现
  // 小红书搜索结果页点击笔记后弹出详情弹窗（.note-detail-mask），URL可能不变或变为 /search_result/{noteId}
  // 首页点击笔记后URL变为 /explore/{noteId}
  const navStart = Date.now();
  const navTimeout = 6000;
  let navSuccess = false;
  while (Date.now() - navStart < navTimeout) {
    if (!shouldContinue || !shouldContinue()) break;
    const checkResult = await dom.execJS(wc, `(function(){
      var url = document.location.href;
      var hasMask = !!document.querySelector('.note-detail-mask');
      var hasNoteId = url.indexOf('${noteId}') !== -1;
      return { url: url.substring(0, 100), hasMask: hasMask, hasNoteId: hasNoteId };
    })()`);
    // 导航成功：URL包含noteId 或 详情弹窗已出现
    if (checkResult && (checkResult.hasNoteId || checkResult.hasMask)) {
      navSuccess = true;
      break;
    }
    await dom.sleep(500);
  }

  if (!navSuccess && pos) {
    log('  模拟点击未触发SPA导航，尝试模拟点击封面图...');
    // 尝试点击封面图（a.cover 是可见的链接，width/height > 30）
    const coverPos = await dom.execJS(wc, `(function(){
      const links = document.querySelectorAll('a.cover[href*="/explore/${noteId}"], a.cover[href*="/search_result/${noteId}"], a.cover[href*="/discovery/item/${noteId}"]');
      for (const a of links) {
        const r = a.getBoundingClientRect();
        if (r.width > 30 && r.height > 30) {
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
        }
      }
      return null;
    })()`);
    if (coverPos) {
      await human.humanClick(wc, coverPos.x, coverPos.y);
      await dom.sleep(2000, 3000);
      // 再次检查
      const recheck = await dom.execJS(wc, `(function(){
        return { hasMask: !!document.querySelector('.note-detail-mask'), url: document.location.href.substring(0, 100) };
      })()`);
      if (recheck && recheck.hasMask) {
        navSuccess = true;
        log('  封面图点击成功，详情弹窗已出现');
      }
    }

    // 最后降级：用 JS 触发 SPA 路由（不用 a.click()，避免页面导航）
    if (!navSuccess) {
      log('  降级用JS触发SPA路由打开笔记...');
      await dom.execJS(wc, `(function(){
        // 查找 a.cover 链接（不用 a[href*="/explore/"]，避免页面导航）
        var links = document.querySelectorAll('a.cover[href*="/search_result/${noteId}"], a.cover[href*="/explore/${noteId}"], a.title[href*="/search_result/${noteId}"], a.title[href*="/explore/${noteId}"]');
        for (var i = 0; i < links.length; i++) {
          var r = links[i].getBoundingClientRect();
          if (r.width > 10 && r.height > 10) {
            // 用 dispatchEvent 触发 click 事件，而不是 a.click()
            // 这样 React/Vue 的 onClick 处理器会被触发，但不会导致页面导航
            var ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            links[i].dispatchEvent(ev);
            return true;
          }
        }
        return false;
      })()`);
      await dom.sleep(2000, 3000);
    }
  }

  await dom.sleep(1500, 2500);

  if (!shouldContinue || !shouldContinue()) {
    if (cdp) cdp.endCollect(noteId);
    return stats;
  }

  // 3. 模拟"阅读"笔记（对标抖音的观看模拟）
  // 鼠标移动到笔记内容区域，模拟真人阅读
  await human.mouseMove(wc, human.rand(300, 700), human.rand(200, 400));

  // 自适应阅读时间：有评论则读久一点
  const quickCommentCount = await dom.execJS(wc, 'document.querySelectorAll("div.comment-item").length') || 0;
  const watchDuration = quickCommentCount > 0 ? human.rand(5000, 15000) : human.rand(3000, 8000);
  log(`  模拟阅读笔记 (${watchDuration}ms, 评论数=${quickCommentCount})`);

  // 阅读期间随机微行为（对标抖音模块）
  const watchStart = Date.now();
  while (Date.now() - watchStart < watchDuration) {
    if (!shouldContinue || !shouldContinue()) break;
    // 40%概率：鼠标移动到随机位置
    if (Math.random() < 0.4) {
      await human.mouseMove(wc, human.rand(350, 650), human.rand(250, 450));
    }
    // 25%概率：小幅滚动
    if (Math.random() < 0.25) {
      await human.mouseScroll(wc, 'down', 1);
    }
    await dom.sleep(800, 1500);
  }

  // 检查详情弹窗是否出现
  const detailCheck = await dom.execJS(wc, `(function(){
    var mask = document.querySelector('.note-detail-mask');
    var comments = document.querySelectorAll('div.comment-item').length;
    var url = document.location.href;
    return JSON.stringify({hasMask:!!mask, comments:comments, url:url.substring(0,80)});
  })()`);
  log(`  详情检查: ${detailCheck}`);

  // 等待评论区出现
  const commentAreaReady = await dom.waitForElement(wc, 'div.comment-item, .note-scroller, .comments-el', 8000);
  if (commentAreaReady) {
    log('  评论区已加载');
  } else {
    log('  评论区未检测到，继续尝试...');
  }

  // 4. 检查验证码
  if (await dom.hasCaptcha(view)) {
    log('  ⚠️ 验证码！等待手动完成...');
    let waitCount = 0;
    while (await dom.hasCaptcha(view) && shouldContinue() && waitCount < 60) {
      await dom.sleep(3000);
      waitCount++;
    }
  }

  // 5. 滚动评论区加载更多评论（对标抖音模块的增强滚动）
  // 找到实际的滚动容器及其位置，针对它发送滚轮事件
  const scrollContainerInfo = await dom.execJS(wc, `(function(){
    // 候选滚动容器选择器（按优先级排序，note-container 是 XHS 笔记详情页的实际滚动容器）
    var selectors = ['.note-container', '.note-scroller', '.comments-el', '.comment-list',
                     '.note-content', 'div[class*="comment"]', 'div[class*="scroll"]'];
    for (var s = 0; s < selectors.length; s++) {
      var els = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var r = el.getBoundingClientRect();
        // 必须可见且有实际滚动空间（scrollHeight 必须大于 clientHeight）
        if (r.width > 100 && r.height > 100 && r.top >= 0 && r.top < window.innerHeight &&
            el.scrollHeight > el.clientHeight + 10) {
          return {
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            selector: selectors[s],
            scrollH: el.scrollHeight,
            clientH: el.clientHeight,
            scrollTop: el.scrollTop
          };
        }
      }
    }
    // 降级：使用任意评论元素的父容器
    var commentEl = document.querySelector('div.comment-item, .comment-inner');
    if (commentEl) {
      var parent = commentEl.parentElement;
      while (parent && parent !== document.body) {
        var pr = parent.getBoundingClientRect();
        if (pr.height > 200 && (parent.scrollHeight > parent.clientHeight + 10)) {
          return {
            x: Math.round(pr.x + pr.width / 2),
            y: Math.round(pr.y + pr.height / 2),
            selector: 'parent-of-comment',
            scrollH: parent.scrollHeight,
            clientH: parent.clientHeight,
            scrollTop: parent.scrollTop
          };
        }
        parent = parent.parentElement;
      }
    }
    return null;
  })()`);
  log(`  滚动容器: ${scrollContainerInfo ? JSON.stringify(scrollContainerInfo) : '未找到'}`);

  // 点击评论区内部，确保键盘/滚轮事件被捕获
  if (scrollContainerInfo) {
    await human.humanClick(wc, scrollContainerInfo.x, scrollContainerInfo.y);
    await dom.sleep(500, 800);
    await human.mouseMove(wc, scrollContainerInfo.x, scrollContainerInfo.y);
  } else {
    // 降级：点击任意评论元素
    const fallbackPos = await dom.execJS(wc, `(function(){
      var el = document.querySelector('div.comment-item, .comments-el');
      if (el) { var r = el.getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + 30)}; }
      return null;
    })()`);
    if (fallbackPos) {
      await human.humanClick(wc, fallbackPos.x, fallbackPos.y);
      await dom.sleep(500, 800);
      await human.mouseMove(wc, fallbackPos.x, fallbackPos.y);
    }
  }

  let prevCommentCount = 0;
  let noNewCount = 0;
  let expiredStreak = 0;
  const maxScrollRounds = 15;
  const scrollTargetX = scrollContainerInfo ? scrollContainerInfo.x : 600;
  const scrollTargetY = scrollContainerInfo ? scrollContainerInfo.y : 400;

  for (let round = 0; round < maxScrollRounds; round++) {
    if (!shouldContinue || !shouldContinue()) break;

    // 交替使用鼠标滚轮和键盘ArrowDown（对标抖音模块）
    const scrollActions = human.rand(3, 5);
    for (let i = 0; i < scrollActions; i++) {
      if (round % 2 === 0) {
        // 偶数轮：鼠标滚轮滚动（针对评论容器位置）
        await human.mouseScrollAt(wc, 'down', 1, scrollTargetX, scrollTargetY);
      } else {
        // 奇数轮：键盘ArrowDown（5-10次，间隔80-200ms）
        const keyCount = human.rand(5, 10);
        for (let k = 0; k < keyCount; k++) {
          await human.keyPress(wc, 'ArrowDown');
          await dom.sleep(80, 200);
        }
      }
      // JS 滚动作为可靠补充（确保评论容器实际滚动）
      await dom.execJS(wc, `(function(){
        var sels = ['.note-container', '.note-scroller', '.comments-el', '.comment-list', 'div[class*="comment"]'];
        for (var i = 0; i < sels.length; i++) {
          var els = document.querySelectorAll(sels[i]);
          for (var j = 0; j < els.length; j++) {
            var el = els[j];
            if (el.scrollHeight > el.clientHeight + 10) {
              el.scrollBy(0, 250 + Math.floor(Math.random() * 150));
              return true;
            }
          }
        }
        // 降级：滚动评论元素的父容器
        var c = document.querySelector('div.comment-item');
        if (c) {
          var p = c.parentElement;
          while (p && p !== document.body) {
            if (p.scrollHeight > p.clientHeight + 10) {
              p.scrollBy(0, 250 + Math.floor(Math.random() * 150));
              return true;
            }
            p = p.parentElement;
          }
        }
        return false;
      })()`);
      await dom.sleep(600, 1200);
    }

    // 20%概率：阅读停顿（对标抖音模块）
    if (Math.random() < 0.2) {
      log('  阅读停顿...');
      await human.humanPause(wc, human.rand(2000, 5000));
    }

    // 检查滚动位置变化（验证滚动是否生效）
    const scrollInfo = await dom.execJS(wc, `(function(){
      var sels = ['.note-container', '.note-scroller', '.comments-el', '.comment-list', 'div[class*="comment"]'];
      for (var i = 0; i < sels.length; i++) {
        var els = document.querySelectorAll(sels[i]);
        for (var j = 0; j < els.length; j++) {
          var el = els[j];
          if (el.scrollHeight > el.clientHeight + 10) {
            return {scrollTop: Math.round(el.scrollTop), scrollH: el.scrollHeight, clientH: el.clientHeight};
          }
        }
      }
      return null;
    })()`);

    // 检查评论数（CDP优先，CDP不可用时用DOM）
    let currentCount = 0;
    let newExpiredCount = 0;
    if (cdp && cdp._webContents) {
      const cdpComments = cdp.getComments(noteId);
      currentCount = cdpComments.length;
      // 时效判断：检查最新加载的评论是否过期（对标抖音模块）
      if (cutoffTs > 0) {
        for (const c of cdpComments) {
          if (c.create_time > 0 && c.create_time < cutoffTs) {
            newExpiredCount++;
          }
        }
      }
    } else {
      const domComments = await dom.readDomComments(view);
      currentCount = domComments.length;
      if (cutoffTs > 0) {
        for (const c of domComments) {
          if (c.create_time > 0 && c.create_time < cutoffTs) {
            newExpiredCount++;
          }
        }
      }
    }
    log(`  [轮${round+1}] 评论数=${currentCount} 滚动=${scrollInfo ? scrollInfo.scrollTop + '/' + scrollInfo.scrollH : 'N/A'} 过期=${newExpiredCount}`);

    // 时效判断：连续过期评论达到阈值则提前终止（对标抖音模块）
    if (newExpiredCount > prevCommentCount * 0.5 && prevCommentCount > 5) {
      expiredStreak++;
      if (expiredStreak >= EXPIRED_THRESHOLD) {
        log(`  连续${EXPIRED_THRESHOLD}轮过期评论占比>50%，提前终止滚动`);
        break;
      }
    } else {
      expiredStreak = 0;
    }

    if (currentCount === prevCommentCount) {
      noNewCount++;
      if (noNewCount >= 2) {
        // 无新评论时尝试快速滚动（对标抖音模块的aggressive retry）
        log('  无新评论，尝试快速滚动...');
        for (let k = 0; k < 20; k++) {
          await human.keyPress(wc, 'ArrowDown');
          await dom.execJS(wc, `(function(){
            var sels = ['.note-container', '.note-scroller'];
            for (var i = 0; i < sels.length; i++) {
              var els = document.querySelectorAll(sels[i]);
              for (var j = 0; j < els.length; j++) {
                if (els[j].scrollHeight > els[j].clientHeight + 10) { els[j].scrollBy(0, 100); return; }
              }
            }
            var c = document.querySelector('div.comment-item');
            if (c) { var p = c.parentElement; while(p && p !== document.body){ if(p.scrollHeight > p.clientHeight+10){ p.scrollBy(0, 100); return; } p = p.parentElement; } } })();
          })()`);
          await dom.sleep(50, 100);
        }
        await dom.sleep(2000, 3000);
      }
      if (noNewCount >= 3) break;
    } else {
      noNewCount = 0;
      prevCommentCount = currentCount;
    }

    if (currentCount >= maxComments) break;
  }

  // 6. 采集评论
  const cdpComments = cdp ? cdp.getComments(noteId) : [];
  const domComments = await dom.readDomComments(view);

  stats.cdp = cdpComments.length;
  stats.dom = domComments.length;

  // 7. 构建笔记信息
  const noteInfo = videoInfo || cdp?.currentNote || {
    note_id: noteId,
    title: '',
    author: '',
    note_url: `https://www.xiaohongshu.com/explore/${noteId}`
  };

  // 8. 合并去重 + 匹配
  const cdpMap = new Map();
  const domMap = new Map();

  for (const c of cdpComments) {
    const key = `${(c.nickname || '').trim()}|${(c.text || '').trim()}`;
    if (key.length > 2) cdpMap.set(key, c);
  }
  for (const c of domComments) {
    const key = `${(c.nickname || '').trim()}|${(c.text || '').trim()}`;
    if (key.length > 2) domMap.set(key, c);
  }

  log(`  CDP评论keys: ${cdpMap.size}, DOM评论keys: ${domMap.size}`);

  const allKeys = new Set([...cdpMap.keys(), ...domMap.keys()]);
  const processed = new Set();

  let filteredShort = 0, filteredDupe = 0, filteredTime = 0, matchAttempt = 0;
  // 记录前几条评论的时间信息用于调试
  let debugTimeSamples = [];

  for (const key of allKeys) {
    if (!shouldContinue || !shouldContinue()) break;

    const cdpComment = cdpMap.get(key) || null;
    const domComment = domMap.get(key) || null;
    const comment = cdpComment || domComment;

    if (!comment || !comment.text || comment.text.length < 3) { filteredShort++; continue; }

    const dedupeKey = (cdpComment && cdpComment.comment_id) || key;
    if (processed.has(dedupeKey)) { filteredDupe++; continue; }
    processed.add(dedupeKey);

    const createTime = cdpComment ? cdpComment.create_time : (domComment ? domComment.create_time : 0);
    // 严格时间过滤：cutoffTs > 0 时，评论必须有有效时间且在范围内
    if (cutoffTs > 0) {
      // 收集前5条评论的时间样本用于调试
      if (debugTimeSamples.length < 5) {
        const timeStr = createTime > 0 ? new Date(createTime * 1000).toLocaleString('zh-CN') : '无时间';
        const cutoffStr = new Date(cutoffTs * 1000).toLocaleString('zh-CN');
        debugTimeSamples.push({
          text: comment.text.substring(0, 20),
          create_time: createTime,
          timeStr,
          source: cdpComment ? 'cdp' : 'dom',
          filtered: createTime <= 0 || createTime < cutoffTs
        });
      }
      if (createTime <= 0) { filteredTime++; continue; } // 无时间信息的评论不采集
      if (createTime < cutoffTs) { filteredTime++; continue; } // 超过时间范围的评论不采集
    }

    matchAttempt++;
    const result = pipeline.processComment(
      cdpComment,
      domComment,
      {
        aweme_id: noteInfo.note_id || noteId,
        desc: noteInfo.title || noteInfo.desc || '',
        author: noteInfo.author || '',
        video_url: noteInfo.note_url || `https://www.xiaohongshu.com/explore/${noteId}`
      },
      keywords
    );

    if (result) {
      stats.matched++;
      result.platform = 'xhs';
      result.note_id = noteInfo.note_id || noteId;
      result.note_title = noteInfo.title || '';
      result.note_author = noteInfo.author || '';
      result.note_url = noteInfo.note_url || '';
      if (onResult) onResult(result);
    }
  }

  // 9. 进度回调
  if (onProgress) {
    onProgress({
      phase: 'done',
      noteId,
      cdpCount: stats.cdp,
      domCount: stats.dom,
      matchCount: stats.matched
    });
  }

  log(`  匹配统计: 尝试=${matchAttempt} 短文本过滤=${filteredShort} 去重过滤=${filteredDupe} 时效过滤=${filteredTime} 命中=${stats.matched}`);
  if (cutoffTs > 0) {
    log(`  时间过滤: cutoff=${new Date(cutoffTs * 1000).toLocaleString('zh-CN')} (60分钟内)`);
    debugTimeSamples.forEach((s, i) => {
      log(`    样本${i+1}: source=${s.source} time=${s.timeStr} create_time=${s.create_time} filtered=${s.filtered} text="${s.text}"`);
    });
  }

  // 10. CDP 结束采集
  if (cdp) cdp.endCollect(noteId);

  // 11. 关闭笔记详情弹窗，返回列表页
  // 先尝试点击关闭按钮
  const closePos = await dom.execJS(wc, `(function(){
    var closeBtn = document.querySelector('.note-detail-mask .close-circle, .note-detail-mask [class*="close"], .close-button');
    if (closeBtn) {
      var r = closeBtn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    }
    return null;
  })()`);
  if (closePos) {
    await human.humanClick(wc, closePos.x, closePos.y);
  } else {
    await human.keyPress(wc, 'Escape');
  }

  // 12. 模拟"浏览后停留"（对标抖音模块的退出后浏览行为）
  await human.humanPause(wc, human.rand(2000, 6000));

  log(`  笔记 ${noteId}: CDP=${stats.cdp} DOM=${stats.dom} 命中=${stats.matched}`);
  return stats;
}

module.exports = { processNote };
