/**
 * 视频处理流程 v4.0 - 严格真人模拟版
 *
 * 核心改进：
 *   1. 每步操作前先鼠标移动到目标位置（模拟视线跟随）
 *   2. 点击视频卡片用鼠标移动+悬停+点击，不用JS click
 *   3. 等待视频真正加载完成（检测feed-active-video + .recommend-fake-video-img消失）
 *   4. 观看视频时模拟鼠标在视频区域自然移动，偶尔暂停/滑动
 *   5. 打开评论区用鼠标点击评论按钮（不用x键），更接近真人
 *   6. 滚动评论区用真实鼠标滚轮（sendInputEvent mouseWheel），不用JS dispatchEvent
 *   7. 退出时先鼠标移开，模拟浏览后离开
 */

const dom = require('./domUtils');
const human = require('./humanBehavior');
const pipeline = require('./pipeline');
const { getLogger } = require('./logger');
const { getStateMachine } = require('./stateMachine');
const { getErrorAnalyzer, CATEGORIES, SEVERITY } = require('./errorAnalyzer');
const { getRecoveryManager } = require('./recovery');

const logger = getLogger('VideoProcessor');

async function processVideo(ctx) {
  const { view, aid, keywords, cdp, shouldContinue, onResult, onLog, cutoffTs = 0, maxComments = 200 } = ctx;
  const wc = view.webContents;
  let realAid = aid;
  const videoInfo = { aweme_id: aid, desc: '', author: '', video_url: aid.startsWith('card_') ? '' : `https://www.douyin.com/video/${aid}` };
  const result = { matched: 0, cdp: 0, dom: 0, effective: 0, skipped: '' };

  const check = () => shouldContinue ? shouldContinue() : true;
  const _log = (msg) => { logger.info(msg); if (onLog) onLog(msg); };
  getStateMachine().setPhase('processing_video', { currentAid: aid });

  try {
    // ===== 1. 点击视频（严格真人模拟） =====
    _log('  1. 点击视频...');
    const clicked = await clickVideoLikeHuman(view, aid);
    if (!clicked) {
      result.skipped = '点击失败';
      _log(`     跳过: 未找到视频元素 ${aid}`);
      return result;
    }

    // ===== 2. 等待视频加载完成（事件驱动，不固定sleep） =====
    _log('  2. 等待视频加载...');
    const loaded = await waitForVideoReady(view);
    if (!loaded) {
      _log('     视频加载超时，继续处理');
    }

    // 从URL中获取真实视频ID
    const currentUrl = await wc.executeJavaScript('location.href').catch(() => '');
    const urlMatch = currentUrl.match(/\/video\/(\d+)/);
    if (urlMatch && urlMatch[1] !== aid) {
      realAid = urlMatch[1];
      videoInfo.aweme_id = realAid;
      videoInfo.video_url = `https://www.douyin.com/video/${realAid}`;
      _log(`     URL获取真实aid: ${realAid} (原始: ${aid})`);
    } else if (aid.startsWith('card_')) {
      const vidFromDom = await wc.executeJavaScript(`(function(){
        const el = document.querySelector('[data-e2e="feed-active-video"]');
        return el ? (el.getAttribute('data-e2e-vid') || '') : '';
      })()`).catch(() => '');
      if (vidFromDom) {
        realAid = vidFromDom;
        videoInfo.aweme_id = realAid;
        videoInfo.video_url = `https://www.douyin.com/video/${realAid}`;
        _log(`     从DOM获取真实aid: ${realAid}`);
      }
    }

    // ===== 3. 模拟观看视频（智能时长 + 自然鼠标行为） =====
    _log('  3. 模拟观看视频...');
    const quickCommentCount = await dom.getCommentCount(view);
    await watchVideoLikeHuman(view, quickCommentCount);

    if (!check()) { result.skipped = '被中断'; return result; }

    // ===== 4. 检测评论数 =====
    _log('  4. 检测评论数...');
    const commentCount = await dom.getCommentCount(view);
    _log(`     评论数: ${commentCount === -1 ? '未知' : commentCount}`);

    const hasFirstComment = await checkFirstComment(wc);
    if (hasFirstComment) {
      _log('     检测到"抢首评"，确认0评论，跳过评论区');
      result.skipped = '无评论(抢首评)';
      await exitVideoLikeHuman(wc);
      return result;
    }

    if (commentCount === 0) {
      _log('     评论数=0，跳过评论区');
      result.skipped = '无评论';
      await exitVideoLikeHuman(wc);
      return result;
    }

    // ===== 5. 打开评论区（鼠标点击评论按钮，不用x键） =====
    _log('  5. 打开评论区...');
    if (cdp) cdp.beginCollect(realAid);
    const opened = await openCommentLikeHuman(view);
    if (!opened) {
      _log('     鼠标点击评论按钮失败，尝试x键');
      await human.keyPress(wc, 'x');
      await sleep(3000, 5000);
    } else {
      await sleep(2000, 4000);
    }

    let commentOpen = await dom.isCommentOpen(view);
    if (!commentOpen) {
      _log('     评论区未打开，再试...');
      await human.keyPress(wc, 'x');
      await sleep(3000, 5000);
      commentOpen = await dom.isCommentOpen(view);
    }

    if (!commentOpen) {
      _log('     评论区未打开，跳过');
      result.skipped = '评论区未打开';
      await exitVideoLikeHuman(wc);
      return result;
    }
    _log('     评论区已打开');

    // ===== 6. 持续滚动加载评论（真实鼠标滚轮 + 时效性驱动） =====
    _log(`  6. 浏览评论区 (上限: ${maxComments}条, 时效性驱动停止)...`);

    // 先点击评论区内部获取焦点
    await focusCommentArea(view);
    await sleep(500, 1000);

    let maxRounds;
    if (commentCount === -1) {
      maxRounds = Math.ceil(maxComments / 10);
    } else {
      const targetCount = Math.min(commentCount, maxComments);
      maxRounds = Math.min(Math.ceil(targetCount / 10), 20);
    }
    _log(`     评论${commentCount === -1 ? '未知' : commentCount}条, 上限${maxComments}条, 最大${maxRounds}轮滚动`);

    let loadedCount = 0;
    let noNewCount = 0;
    let expiredStreak = 0;
    const EXPIRED_THRESHOLD = 5;
    let lastCheckedCount = 0;

    for (let round = 0; round < maxRounds; round++) {
      if (!check()) break;

      const beforeCount = cdp ? cdp.getComments(realAid).length : 0;

      // ★ 真实鼠标滚轮滚动评论区（3-5次，模拟真人连续浏览）
      const scrollTimes = rand(3, 5);
      for (let s = 0; s < scrollTimes; s++) {
        // 交替：真实鼠标滚轮 + ArrowDown键
        if (s % 2 === 0) {
          await scrollCommentsWithMouseWheel(view, rand(300, 600));
        } else {
          for (let k = 0; k < rand(5, 10); k++) {
            await human.keyPress(wc, 'ArrowDown');
            await sleep(80, 200);
          }
        }
        await sleep(600, 1200);
      }

      // 模拟鼠标在评论区内移动
      await human.mouseMove(wc, rand(500, 750), rand(300, 700));
      await sleep(1500, 3000);

      const afterCount = cdp ? cdp.getComments(realAid).length : 0;
      loadedCount = afterCount;

      if (afterCount > beforeCount) {
        noNewCount = 0;
        _log(`     第${round + 1}/${maxRounds}轮 已加载${afterCount}条 (+${afterCount - beforeCount})`);

        // 时效性检查
        if (cutoffTs > 0) {
          const allCdpComments = cdp.getComments(realAid);
          let shouldStop = false;
          for (let i = lastCheckedCount; i < allCdpComments.length; i++) {
            const ct = allCdpComments[i].create_time || 0;
            if (ct > 0 && ct < cutoffTs) {
              expiredStreak++;
            } else {
              expiredStreak = 0;
            }
            if (expiredStreak >= EXPIRED_THRESHOLD) {
              shouldStop = true;
              break;
            }
          }
          lastCheckedCount = allCdpComments.length;

          if (shouldStop) {
            _log(`     连续${expiredStreak}条评论超出时效范围，停止加载`);
            break;
          }
        }
      } else {
        noNewCount++;
        if (noNewCount === 1) {
          _log(`     第${round + 1}轮无新评论，尝试快速滚动...`);
          for (let k = 0; k < 20; k++) {
            await human.keyPress(wc, 'ArrowDown');
            await sleep(50, 100);
          }
          await sleep(2000, 3000);
          const retryCount = cdp ? cdp.getComments(realAid).length : 0;
          if (retryCount > afterCount) {
            noNewCount = 0;
            loadedCount = retryCount;
            _log(`     快速滚动后加载${retryCount}条 (+${retryCount - afterCount})`);
            if (cutoffTs > 0) {
              const allCdpComments = cdp.getComments(realAid);
              let shouldStopFast = false;
              for (let i = lastCheckedCount; i < allCdpComments.length; i++) {
                const ct = allCdpComments[i].create_time || 0;
                if (ct > 0 && ct < cutoffTs) {
                  expiredStreak++;
                } else {
                  expiredStreak = 0;
                }
                if (expiredStreak >= EXPIRED_THRESHOLD) {
                  shouldStopFast = true;
                  break;
                }
              }
              lastCheckedCount = allCdpComments.length;
              if (shouldStopFast) {
                _log(`     连续${expiredStreak}条评论超出时效范围，停止加载`);
                break;
              }
            }
          }
        }
      }

      if (loadedCount >= maxComments) {
        _log(`     已加载${loadedCount}条 >= 上限${maxComments}条，停止滚动`);
        break;
      }

      if (noNewCount >= 5) {
        _log(`     连续5轮无新评论，可能已到底部`);
        break;
      }

      // 偶尔暂停模拟阅读
      if (Math.random() < 0.2) {
        await sleep(2000, 5000);
      }
    }

    await wait(2000, 5000);
    if (!check()) { result.skipped = '被中断'; return result; }

    // ===== 7. 采集评论 =====
    _log('  7. 采集评论...');
    _log(`     查询aid=${realAid}, cutoffTs=${cutoffTs}`);
    let cdpComments = [];
    if (cdp) {
      for (let i = 0; i < 10; i++) {
        cdpComments = cdp.getComments(realAid);
        if (cdpComments.length > 0) break;
        await wait(500, 800);
      }
    }
    if (cdpComments.length > 0) {
      const ctSamples = cdpComments.slice(0, 3).map(c => `${c.create_time || 0}`).join(',');
      _log(`     CDP评论时间样本: [${ctSamples}], now=${Math.floor(Date.now()/1000)}`);
    }
    const domComments = await dom.readDomComments(view);
    {
      const domDiag = await wc.executeJavaScript(`(function(){
        const items = document.querySelectorAll('[data-e2e="comment-item"]');
        const altItems = document.querySelectorAll('[class*="comment-item"]');
        const listEl = document.querySelector('[data-e2e="comment-list"]');
        return {
          e2eItems: items.length,
          altItems: altItems.length,
          hasList: !!listEl,
          listChildren: listEl ? listEl.children.length : 0,
          domRaw: ${domComments.length}
        };
      })()`).catch(() => ({}));
      _log(`     DOM诊断: raw=${domComments.length}, e2e=${domDiag.e2eItems || 0}, alt=${domDiag.altItems || 0}, list=${domDiag.hasList}`);
    }

    // 提取视频作者信息
    const authorInfo = await wc.executeJavaScript(`
      (function(){
        const info = { author: '', desc: '', profileUrl: '' };
        const userLinks = document.querySelectorAll('a[href*="/user/"]');
        for (const a of userLinks) {
          const r = a.getBoundingClientRect();
          if (r.width > 5 && r.height > 5) {
            const href = a.getAttribute('href') || '';
            const name = (a.innerText || '').trim().replace(/^@/, '');
            if (name.length > 0 && name.length < 30) {
              info.author = name;
              info.profileUrl = href.startsWith('http') ? href : (href.startsWith('//') ? 'https:' + href : (href.startsWith('/') ? 'https://www.douyin.com' + href : 'https://www.douyin.com/' + href));
              break;
            }
          }
        }
        const spans = document.querySelectorAll('span, p');
        for (const s of spans) {
          const t = (s.innerText || '').trim();
          if (t.length > 10 && t.length < 500 && t.includes('#')) {
            info.desc = t;
            break;
          }
        }
        return info;
      })()
    `).catch(() => ({ author: '', desc: '', profileUrl: '' }));

    if (cdp?.currentVideo?.aweme_id === realAid) {
      videoInfo.desc = videoInfo.desc || cdp.currentVideo.desc || authorInfo.desc || '';
      videoInfo.author = videoInfo.author || cdp.currentVideo.author || authorInfo.author || '';
    } else {
      videoInfo.desc = videoInfo.desc || authorInfo.desc || '';
      videoInfo.author = videoInfo.author || authorInfo.author || '';
    }
    if (authorInfo.profileUrl && !videoInfo.authorProfile) {
      videoInfo.authorProfile = authorInfo.profileUrl;
    }

    result.cdp = cdpComments.length;
    result.dom = domComments.length;

    // 合并 CDP + DOM 评论
    const cdpMap = new Map();
    for (const c of cdpComments) {
      const text = (c.text || '').trim();
      if (!text) continue;
      const ct = c.create_time || 0;
      if (cutoffTs > 0 && ct > 0 && ct < cutoffTs) continue;
      if (!cdpMap.has(text)) cdpMap.set(text, c);
    }
    const domMap = new Map();
    for (const d of domComments) {
      const text = (d.text || '').trim();
      if (!text || domMap.has(text)) continue;
      const dt = d.create_time || 0;
      if (cutoffTs > 0 && dt > 0 && dt < cutoffTs) continue;
      if (cutoffTs > 0 && dt === 0) {
        const cdpMatch = cdpComments.find(c => (c.text || '').trim() === text);
        if (cdpMatch && cdpMatch.create_time > 0 && cdpMatch.create_time < cutoffTs) {
          continue;
        }
      }
      domMap.set(text, d);
    }
    const allTexts = new Set([...cdpMap.keys(), ...domMap.keys()]);
    const allComments = [];
    for (const text of allTexts) {
      allComments.push({
        cdp: cdpMap.get(text) || null,
        dom: domMap.get(text) || null
      });
    }

    result.effective = allComments.length;
    result.cdp = cdpMap.size;
    result.dom = domMap.size;
    _log(`     CDP:${cdpMap.size} DOM:${domMap.size} 有效:${allComments.length}`);

    if (domComments.length > 0) {
      const domTimeDiag = domComments.slice(0, 5).map(d =>
        `${(d.text || '').slice(0, 15)}: ct=${d.create_time || 0}`
      ).join(' | ');
      _log(`     DOM时间样本: [${domTimeDiag}]`);
    }

    if (allComments.length === 0) {
      result.skipped = '无有效评论';
      if (cdp) cdp.endCollect(realAid);
      await closeCommentAndExit(wc);
      return result;
    }

    // ===== 8. 匹配关键词 + 补全抖音号 =====
    _log('  8. 匹配关键词...');
    let matched = 0;
    for (const pair of allComments) {
      if (!check()) break;
      const r = pipeline.processComment(pair.cdp, pair.dom, videoInfo, keywords);
      if (r) {
        if (!r.douyin_id || r.douyin_id === r.uid) {
          const profileUrl = r.profile_url || (pair.cdp && pair.cdp.profile_url) || (pair.dom && pair.dom.profile_url) || '';
          if (profileUrl) {
            try {
              const fetchedId = await dom.fetchDouyinId(wc, profileUrl);
              if (fetchedId) {
                r.douyin_id = fetchedId;
                _log(`     补全抖音号: ${fetchedId}`);
              }
            } catch (_) {}
          }
        }
        matched++;
        if (onResult) onResult(r);
      }
    }
    result.matched = matched;

    // ===== 9. 关闭评论区 + 浏览后退出 =====
    if (cdp) cdp.endCollect(realAid);
    await closeCommentAndExit(wc);

    return result;
  } catch (e) {
    const analyzed = getErrorAnalyzer().analyze(e, { aid, phase: 'process_video' });
    result.skipped = `${analyzed.category}: ${analyzed.message}`;
    if (cdp) try { cdp.endCollect(realAid); } catch(_) {}
    try { await exitVideoLikeHuman(wc); } catch(_) {}
    _log(`  ❌ [${analyzed.category}] ${analyzed.message} → ${analyzed.suggestion}`);
    getStateMachine().setError(analyzed.message, { category: analyzed.category, aid });
    if (analyzed.severity === SEVERITY.FATAL) {
      getRecoveryManager().autoRecover(analyzed, { aid, phase: 'video_processing' }).catch(() => {});
    }
    return result;
  } finally {
    getStateMachine().setPhase('video_done', { lastAid: aid });
  }
}

// ========== 真人模拟子流程 ==========

/**
 * 真人式点击视频卡片
 * 流程：找到卡片位置 → 鼠标移动到卡片 → 悬停 → 点击
 */
async function clickVideoLikeHuman(view, aid) {
  const wc = view.webContents;

  // 获取卡片位置
  let pos = null;
  if (aid && aid.startsWith('card_')) {
    const cardIdx = parseInt(aid.replace('card_', ''));
    pos = await wc.executeJavaScript(`(function(){
      const cards = document.querySelectorAll('.search-result-card');
      const videoCards = [];
      for (const card of cards) {
        const text = (card.innerText || '');
        const durationMatch = text.match(/^(\\d{1,2}:\\d{2})/m);
        if (durationMatch) {
          const r = card.getBoundingClientRect();
          if (r.width > 50 && r.height > 50) videoCards.push(card);
        }
      }
      if (${cardIdx} < videoCards.length) {
        const card = videoCards[${cardIdx}];
        card.scrollIntoView({ block: 'center' });
        const r = card.getBoundingClientRect();
        return { x: r.x+r.width/2, y: r.y+r.height/2 };
      }
      return null;
    })()`).catch(() => null);
  } else {
    pos = await wc.executeJavaScript(`(function(){
      const links = document.querySelectorAll('a[href*="/video/${aid}"]');
      for (const a of links) {
        a.scrollIntoView({ block: 'center' });
        const r = a.getBoundingClientRect();
        if (r.width > 50 && r.height > 50)
          return { x: r.x+r.width/2, y: r.y+r.height/2 };
      }
      const el = document.querySelector('[data-e2e-vid="${aid}"]');
      if (el) {
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x+r.width/2, y: r.y+r.height/2 };
      }
      return null;
    })()`).catch(() => null);
  }

  if (!pos) return false;

  // ★ 真人操作：先移动鼠标到卡片 → 悬停 → 点击
  await sleep(500, 1000);
  await human.mouseMove(wc, pos.x, pos.y);
  await sleep(200, 500);  // 悬停
  await human.humanClick(wc, pos.x, pos.y);
  return true;
}

/**
 * 等待视频真正加载完成
 * 检测：feed-active-video出现 + recommend-fake-video-img消失
 */
async function waitForVideoReady(view) {
  const wc = view.webContents;
  const start = Date.now();
  const timeout = 10000;

  while (Date.now() - start < timeout) {
    const ready = await wc.executeJavaScript(`(function(){
      // 检测视频播放器是否就绪
      const activeVideo = document.querySelector('[data-e2e="feed-active-video"]');
      const fakeImg = document.querySelector('.recommend-fake-video-img');
      return {
        hasActiveVideo: !!activeVideo,
        hasFakeImg: !!fakeImg,
        ready: !!activeVideo && !fakeImg
      };
    })()`).catch(() => ({ ready: false }));

    if (ready.ready) return true;
    await sleep(300, 500);
  }
  return false;
}

/**
 * 真人式观看视频
 * - 根据评论数决定观看时长（有评论看久一点）
 * - 鼠标在视频区域自然移动
 * - 偶尔模拟暂停/滑动行为
 */
async function watchVideoLikeHuman(view, commentCount) {
  const wc = view.webContents;

  // 获取视频区域位置
  const videoRect = await wc.executeJavaScript(`(function(){
    const el = document.querySelector('[data-e2e="feed-active-video"]') ||
               document.querySelector('video');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`).catch(() => null);

  // 观看时长：有评论看久一点
  const viewTime = commentCount > 0 ? rand(5000, 12000) : rand(3000, 8000);
  const startTime = Date.now();

  while (Date.now() - startTime < viewTime) {
    // 鼠标在视频区域自然移动
    if (videoRect) {
      const mx = videoRect.x + rand(50, videoRect.w - 50);
      const my = videoRect.y + rand(50, videoRect.h - 50);
      await human.mouseMove(wc, mx, my);
    }
    await sleep(800, 2000);

    // 3%概率模拟鼠标移到视频中心（极低频率，不点击）
    if (Math.random() < 0.03 && videoRect) {
      const cx = videoRect.x + videoRect.w / 2;
      const cy = videoRect.y + videoRect.h / 2;
      await human.mouseMove(wc, cx, cy);
      await sleep(200, 400);
    }

    // 5%概率轻微滚动（模拟调整姿势，极低频率）
    if (Math.random() < 0.05) {
      await human.mouseScroll(wc, 'down', 1);
      await sleep(300, 600);
    }
  }
}

/**
 * 真人式打开评论区
 * 用鼠标点击评论按钮，不用x键
 */
async function openCommentLikeHuman(view) {
  const wc = view.webContents;

  // 查找评论按钮位置
  const btnPos = await wc.executeJavaScript(`(function(){
    // 策略1: data-e2e
    let icon = document.querySelector('[data-e2e="feed-comment-icon"]') ||
               document.querySelector('[data-e2e="comment-icon"]');
    // 策略2: class含comment和icon
    if (!icon) {
      const candidates = document.querySelectorAll('[class*="comment" i]');
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width > 10 && r.height > 10 && r.x > window.innerWidth * 0.5) {
          // 右侧的评论相关元素
          icon = el;
          break;
        }
      }
    }
    if (!icon) return null;
    const r = icon.getBoundingClientRect();
    // 获取包含数字的父元素（整个评论按钮区域）
    let parent = icon.parentElement;
    while (parent && parent.parentElement) {
      const pr = parent.getBoundingClientRect();
      if (pr.width > 20 && pr.height > 20) break;
      parent = parent.parentElement;
    }
    const target = parent || icon;
    const tr = target.getBoundingClientRect();
    return { x: tr.x + tr.width/2, y: tr.y + tr.height/2 };
  })()`).catch(() => null);

  if (!btnPos) return false;

  // 真人操作：移动鼠标 → 悬停 → 点击
  await human.mouseMove(wc, btnPos.x, btnPos.y);
  await sleep(200, 500);
  await human.humanClick(wc, btnPos.x, btnPos.y);
  return true;
}

/**
 * 聚焦评论区（点击评论区内部获取焦点）
 */
async function focusCommentArea(view) {
  const wc = view.webContents;
  await wc.executeJavaScript(`(function(){
    const list = document.querySelector('[data-e2e="comment-list"]');
    if (list) { list.click(); return; }
    const panel = document.querySelector('.comment-mainContent') ||
                  document.querySelector('#videoSideCard [class*="comment"]');
    if (panel) panel.click();
  })()`).catch(() => {});
}

/**
 * 用真实鼠标滚轮滚动评论区
 * 使用 wc.sendInputEvent mouseWheel，这是Electron原生事件，最接近真实用户操作
 */
async function scrollCommentsWithMouseWheel(view, deltaY) {
  const wc = view.webContents;

  // 获取评论区位置（用于确定鼠标滚轮的坐标）
  const commentRect = await wc.executeJavaScript(`(function(){
    const list = document.querySelector('[data-e2e="comment-list"]');
    if (!list) return null;
    const r = list.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height };
  })()`).catch(() => null);

  // 鼠标位置：评论区中心
  const mx = commentRect ? commentRect.x : 600;
  const my = commentRect ? commentRect.y : 400;

  // 先移动鼠标到评论区
  await human.mouseMove(wc, mx, my);
  await sleep(100, 300);

  // ★ 发送真实鼠标滚轮事件（Electron原生，最接近真实用户）
  try {
    await wc.sendInputEvent({
      type: 'mouseWheel',
      x: Math.round(mx),
      y: Math.round(my),
      deltaX: 0,
      deltaY: deltaY,
      wheelTicksX: 0,
      wheelTicksY: Math.round(deltaY / 40),
      accelerationRatioX: 0,
      accelerationRatioY: 1,
      hasPreciseScrollingDeltas: false,
      canScroll: true
    });
  } catch (_) {}

  // 同时也用JS dispatchEvent双保险
  await wc.executeJavaScript(`(function(){
    const list = document.querySelector('[data-e2e="comment-list"]');
    let scrollTarget = null;
    if (list) {
      let p = list;
      while (p) {
        const s = getComputedStyle(p);
        if (s.overflowY === 'auto' || s.overflowY === 'scroll') {
          scrollTarget = p; break;
        }
        p = p.parentElement;
      }
      if (!scrollTarget) scrollTarget = list;
    }
    if (!scrollTarget) {
      scrollTarget = document.querySelector('.comment-mainContent') ||
                     document.querySelector('#videoSideCard [class*="comment"]');
    }
    if (scrollTarget) {
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: ${deltaY}, deltaMode: 0, bubbles: true, cancelable: true
      });
      scrollTarget.dispatchEvent(wheelEvent);
      scrollTarget.scrollBy({ top: ${deltaY}, behavior: 'smooth' });
    }
  })()`).catch(() => {});

  await sleep(800, 1500);
}

/**
 * 检测"抢首评"标记
 */
async function checkFirstComment(wc) {
  try {
    const r = await wc.executeJavaScript(`(function(){
      const body = document.body.innerText;
      if (body.includes('抢首评')) return true;
      const icon = document.querySelector('[data-e2e="feed-comment-icon"]') ||
                   document.querySelector('[data-e2e="comment-icon"]');
      if (icon) {
        const parent = icon.parentElement;
        if (parent && (parent.innerText || '').includes('抢首评')) return true;
      }
      return false;
    })()`);
    return r === true;
  } catch (_) {
    return false;
  }
}

/**
 * 真人式关闭评论区 + 退出
 * 流程：鼠标移开 → 关闭评论区 → 浏览视频 → ESC退出
 */
async function closeCommentAndExit(wc) {
  // 1. 鼠标移到视频区域（模拟看完评论后看视频）
  await human.mouseMove(wc, rand(200, 500), rand(200, 400));
  await sleep(500, 1000);

  // 2. 关闭评论区
  try {
    const commentOpen = await wc.executeJavaScript(`(function(){
      const el = document.querySelector('#videoSideCard');
      return el ? el.clientWidth > 0 : false;
    })()`).catch(() => false);
    if (commentOpen) {
      await human.keyPress(wc, 'x');
      await sleep(800, 1500);
      const stillOpen = await wc.executeJavaScript(`(function(){
        const el = document.querySelector('#videoSideCard');
        return el ? el.clientWidth > 0 : false;
      })()`).catch(() => false);
      if (stillOpen) {
        // 点击评论区外部关闭
        const vp = await wc.executeJavaScript(`({ w: window.innerWidth, h: window.innerHeight })`).catch(() => ({ w: 800, h: 600 }));
        await human.mouseMove(wc, Math.round(vp.w * 0.2), Math.round(vp.h * 0.5));
        await human.humanClick(wc, Math.round(vp.w * 0.2), Math.round(vp.h * 0.5));
        await sleep(500, 1000);
      }
    }
  } catch (_) {}

  // 3. 浏览视频2-6s
  await sleep(2000, 6000);
  await human.mouseMove(wc, rand(200, 600), rand(200, 500));

  // 4. ESC退出
  try { await human.keyPress(wc, 'Escape'); } catch(_) {}
  await sleep(1000, 3000);
}

/**
 * 真人式退出视频（0评论/未打开评论区时）
 */
async function exitVideoLikeHuman(wc) {
  // 检查评论区是否意外打开
  try {
    const commentOpen = await wc.executeJavaScript(`(function(){
      const el = document.querySelector('#videoSideCard');
      return el ? el.clientWidth > 0 : false;
    })()`).catch(() => false);
    if (commentOpen) {
      await human.keyPress(wc, 'x');
      await sleep(800, 1500);
    }
  } catch (_) {}

  // 模拟浏览视频
  await human.mouseMove(wc, rand(200, 600), rand(200, 500));
  await sleep(2000, 6000);
  try { await human.keyPress(wc, 'Escape'); } catch(_) {}
  await sleep(1000, 3000);
}

// ========== 工具 ==========

async function wait(min, max) {
  const total = max ? rand(min, max) : min;
  const step = 500;
  for (let t = 0; t < total; t += step) {
    try {
      const search = require('./search');
      if (!search.isRunning()) return false;
      if (search.isPaused && search.isPaused()) {
        while (search.isPaused() && search.isRunning()) {
          await sleep(500);
        }
        if (!search.isRunning()) return false;
      }
    } catch(_) {}
    await sleep(step);
  }
  return true;
}

function sleep(a, b) { const ms = b ? rand(a,b) : a; return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random()*(b-a)+a); }

module.exports = { processVideo };
