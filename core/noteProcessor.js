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
    log(`  笔记未找到，尝试导航: ${noteId}`);
    try {
      await view.webContents.loadURL(`https://www.xiaohongshu.com/explore/${noteId}`);
    } catch (e) {
      stats.skipped = '导航失败';
      if (cdp) cdp.endCollect(noteId);
      return stats;
    }
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

    // 最后降级：DOM click（但只点击可见链接）
    if (!navSuccess) {
      log('  降级用DOM click点击可见链接...');
      await dom.execJS(wc, `(function(){
        const links = document.querySelectorAll('a.cover[href*="/explore/${noteId}"], a.cover[href*="/search_result/${noteId}"], a.cover[href*="/discovery/item/${noteId}"], a.title[href*="/explore/${noteId}"], a.title[href*="/search_result/${noteId}"]');
        for (const a of links) {
          const r = a.getBoundingClientRect();
          if (r.width > 10 && r.height > 10) { a.click(); break; }
        }
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
  // 先点击评论区内部，确保键盘事件被评论区捕获
  const commentListPos = await dom.execJS(wc, `(function(){
    var el = document.querySelector('.note-scroller, .comments-el, div.comment-item');
    if (el) { var r = el.getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + 30)}; }
    return null;
  })()`);
  if (commentListPos) {
    await human.humanClick(wc, commentListPos.x, commentListPos.y);
    await dom.sleep(300, 600);
  }

  let prevCommentCount = 0;
  let noNewCount = 0;
  let expiredStreak = 0;
  const maxScrollRounds = 15;

  for (let round = 0; round < maxScrollRounds; round++) {
    if (!shouldContinue || !shouldContinue()) break;

    // 交替使用鼠标滚轮和键盘ArrowDown（对标抖音模块）
    const scrollActions = human.rand(3, 5);
    for (let i = 0; i < scrollActions; i++) {
      if (round % 2 === 0) {
        // 偶数轮：鼠标滚轮滚动
        await human.mouseScroll(wc, 'down', 1);
      } else {
        // 奇数轮：键盘ArrowDown（5-10次，间隔80-200ms）
        const keyCount = human.rand(5, 10);
        for (let k = 0; k < keyCount; k++) {
          await human.keyPress(wc, 'ArrowDown');
          await dom.sleep(80, 200);
        }
      }
      await dom.sleep(600, 1200);
    }

    // 20%概率：阅读停顿（对标抖音模块）
    if (Math.random() < 0.2) {
      log('  阅读停顿...');
      await human.humanPause(wc, human.rand(2000, 5000));
    }

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
    if (cutoffTs > 0 && createTime > 0 && createTime < cutoffTs) { filteredTime++; continue; }

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
