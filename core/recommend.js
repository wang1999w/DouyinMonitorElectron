/**
 * Recommend page browsing module
 *
 * Features:
 *   1. Automatically browse the Douyin recommendation page
 *   2. Recognize video descriptions and match video keywords
 *   3. Keyword-matched videos -> open comments -> simulate browsing -> load fresh comments -> collect intent info
 *   4. Support task end time configuration
 *   5. Loop browsing until the task is finished
 *
 * Standalone module, independent of search/monitor modules
 */

const { getDouyinView } = require('../main/window');
const { getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const dom = require('./domUtils');
const pipeline = require('./pipeline');
const match = require('./match');
const { getLogger } = require('./logger');
const videoProcessor = require('./videoProcessor');
const { getStateMachine, STATES } = require('./stateMachine');

const logger = getLogger('RecommendEngine');

let recommendRunning = false;
let recommendPaused = false;
let _completeCallback = null;
let _lastMatchedTotal = 0;
let logCallback = null;
let progressCallback = null;
let resultCallback = null;
let currentTask = null;

function isRunning() { return recommendRunning; }
function isPaused() { return recommendPaused; }

async function stopRecommend() {
  if (!recommendRunning && !recommendPaused) {
    log('No running recommend task');
    return { stopped: false, reason: 'not_running' };
  }
  log('Stopping recommend task...');
  recommendRunning = false;
  recommendPaused = false;
  // Immediately trigger videoProcessor module-level interrupt flag
  videoProcessor.setInterruptFlag && videoProcessor.setInterruptFlag(true);
  if (currentTask) currentTask.stopped = true;

  const state = getStateMachine();
  if (state.current === STATES.SEARCHING || state.current === STATES.PAUSED) {
    state.transition(STATES.IDLE, { phase: 'user_stopped' });
  }

  const matchedTotal = currentTask ? currentTask.matchedTotal : _lastMatchedTotal;
  for (let i = 0; i < 15; i++) {
    await sleep(100);
  }
  log('Recommend task stopped');
  if (_completeCallback) {
    try { _completeCallback({ success: true, reason: 'user_stopped', matchedTotal }); }
    catch (e) { console.warn('stopRecommend onComplete error:', e.message); }
    _completeCallback = null;
  }
  return { stopped: true, reason: 'user_stopped' };
}

async function pauseRecommend() {
  if (!recommendRunning) {
    log('No running recommend task to pause');
    return { paused: false, reason: 'not_running' };
  }
  recommendPaused = !recommendPaused;
  // ★ 修复：暂停时不设置 _globalInterrupted（那会导致processRecommendVideo完全退出）
  // 暂停通过 shouldContinue 回调返回 false 来实现，wait/sleep 内部会等待恢复
  // 只有停止时才设置 _globalInterrupted = true
  if (videoProcessor.setInterruptFlag) {
    videoProcessor.setInterruptFlag(false);
  }
  const state = getStateMachine();
  if (recommendPaused) {
    state.transition(STATES.PAUSED, { phase: 'user_paused' });
    log('Paused (click resume to continue)');
  } else {
    state.transition(STATES.SEARCHING, { phase: 'resumed' });
    log('Resumed');
  }
  return { paused: recommendPaused };
}

// ========== Interruptible wait ==========

async function wait(min, max) {
  const total = max ? rand(min, max) : min;
  const step = 300;
  for (let t = 0; t < total; t += step) {
    if (!recommendRunning) return false;
    if (recommendPaused) {
      log('Paused');
      while (recommendPaused) { await sleep(300); if (!recommendRunning) return false; }
      log('Resumed');
    }
    await sleep(step);
  }
  return true;
}

// ========== Main flow ==========

/**
 * Start recommendation page browsing
 * @param {object} params - { videoKeywords, commentHours, maxComments, endTime }
 * @param {function} onLog - log callback
 * @param {function} onResult - matched result callback
 * @param {function} onProgress - progress callback
 */
async function startRecommend(params, onLog, onResult, onProgress, onComplete) {
  if (recommendRunning) {
    log('A recommend browse task is already running, please stop first');
    if (_completeCallback) { try { _completeCallback({ success: false, reason: 'already_running' }); } catch (_) {} _completeCallback = null; }
    return;
  }
  recommendRunning = true;
  recommendPaused = false;
  _completeCallback = onComplete;
  _lastMatchedTotal = 0;
  // Reset videoProcessor module-level interrupt flag
  if (videoProcessor.setInterruptFlag) videoProcessor.setInterruptFlag(false);
  logCallback = onLog;
  resultCallback = onResult;
  progressCallback = onProgress;

  const task = {
    params,
    processedIds: new Set(),
    stopped: false,
    matchedTotal: 0,
    videoCount: 0,
    startTime: Date.now(),
    endTime: params.endTime || 0 // timestamp, 0=no limit
  };
  currentTask = task;

  const videoKeywords = params.videoKeywords || [];
  const commentHours = params.commentHours || 60;
  const maxComments = params.maxComments || 200;
  const commentSort = params.commentSort || '';  // comment sorting: newest/hottest/default
  const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 3600;

  log('Starting recommend browse | keywords: ' + videoKeywords.join(', ') + ' | comment age limit: ' + commentHours + ' hours');
  if (task.endTime) {
    const endDate = new Date(task.endTime);
    log('Task end time: ' + endDate.toLocaleString());
  }

  // State machine: enter SEARCHING
  getStateMachine().transition(STATES.SEARCHING, {
    phase: 'starting',
    taskDesc: 'Recommend_' + videoKeywords.slice(0, 3).join(',')
  });

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('Browser not ready'); return; }
    const wc = view.webContents;

    // Wait for page to finish loading (prevent executeJavaScript hang)
    log('  Waiting for page load...');
    let pageReady = false;
    for (let i = 0; i < 20 && recommendRunning; i++) {
      const ready = await js(wc, 'document.readyState === "complete" || document.readyState === "interactive"');
      const hasBody = await js(wc, 'document.body && document.body.innerText.length > 50');
      if (ready === true && hasBody === true) { pageReady = true; break; }
      if (!await wait(1000)) break;
    }
    if (!pageReady) { log('  Page load timeout, continuing...'); }
    else { log('  Page ready'); }

    // Navigate to recommend page (home)
    await navigateToRecommend(view);

    // Check login
    await checkLogin(view);

    // Check captcha
    if (await dom.hasCaptcha(view)) {
      log('Captcha! Please complete manually');
      let captchaRetry = 0;
      while (await dom.hasCaptcha(view) && recommendRunning && captchaRetry < 20) {
        await wait(3000);
        captchaRetry++;
      }
      if (captchaRetry >= 20) {
        log('  Captcha wait timeout (60s), continuing (some features may be limited)');
      } else {
        log('Captcha passed');
      }
    }

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const cdp = getCDPInterceptor();

    let scrollTry = 0;
    let sincePause = 0;
    let pauseAfter = rand(2, 5);

    // Main loop: continuously browse recommend page
    const taskStartTs = Date.now();
    const MAX_RUN_MS = 12 * 60 * 60 * 1000; // global max 12h, to prevent infinite run when forgotten

    while (recommendRunning && !task.stopped) {
      // Global execution time safety check
      if (Date.now() - taskStartTs > MAX_RUN_MS) {
        log('Max execution time reached (12h), auto-stop');
        recommendRunning = false;
        break;
      }
      // Check task end time
      if (task.endTime && Date.now() >= task.endTime) {
        log('Task end time reached, stop browsing');
        break;
      }

      // Get currently playing video info
      const videoInfo = await getCurrentFeedVideo(view);

      if (!videoInfo || !videoInfo.vid) {
        scrollTry++;
        if (scrollTry > 5) {
          log('No video detected, try re-navigate recommend page...');
          await navigateToRecommend(view);
          scrollTry = 0;
        }
        // Scroll to next video
        await swipeNextVideo(wc);
        await wait(3000, 5000);
        continue;
      }
      scrollTry = 0;

      // Skip already processed videos
      if (task.processedIds.has(videoInfo.vid)) {
        await swipeNextVideo(wc);
        await wait(2000, 4000);
        continue;
      }
      task.processedIds.add(videoInfo.vid);
      task.videoCount++;

      log('\n--- [' + task.videoCount + '] Video ' + videoInfo.vid + ' ---');

      // Extract video description + hashtags
      const desc = await extractVideoDesc(view);
      log('  Description: ' + (desc || '').substring(0, 80) + ((desc || '').length > 80 ? '...' : ''));

      // Match video keywords
      const kwMatch = matchVideoKeywords(desc, videoKeywords);

      if (!kwMatch.hit) {
        log('  Keywords not hit, continue browsing');
        // Simulate watching for a while then slide away
        await wait(3000, 8000);
        await swipeNextVideo(wc);
        continue;
      }

      log('  Keywords hit: ' + kwMatch.keywords.join(', '));

      // Keyword hit -> open comments for collection
      const videoResult = await processRecommendVideo({
        view,
        aid: videoInfo.vid,
        desc,
        matchedVideoKeywords: kwMatch.keywords,
        keywords: { intent: intentKw, garbage: garbageKw },
        cdp,
        shouldContinue: function() { return recommendRunning && !recommendPaused && !task.stopped; },
        onResult,
        onLog: log,
        maxComments,
        cutoffTs,
        commentHours,
        commentSort,
        onProgress: function(info) {
          if (typeof onProgress === 'function') {
            try {
              onProgress({
                ...info,
                videoCount: task.videoCount,
                matchedTotal: task.matchedTotal
              });
            } catch (_) {}
          }
        }
      });

      if (videoResult.matched > 0) {
        task.matchedTotal += videoResult.matched;
        log('  This video matched: ' + videoResult.matched + ' intent comments');
      }

      // Close comments and exit video details
      // processRecommendVideo handles exit internally

      // Random pause (simulate real user behavior)
      sincePause++;
      if (sincePause >= pauseAfter) {
        const sec = rand(10, 40);
        log('Resting ' + sec + 's...');
        if (!await wait(sec * 1000)) break;
        sincePause = 0;
        pauseAfter = rand(2, 5);
      }

      // Slide to next video
      await swipeNextVideo(wc);
      await wait(2000, 4000);
    }

    // ★ 区分：正常完成 vs 用户主动停止
    if (task && task.stopped) {
      log('🛑 Recommend browse stopped! Total browsed ' + task.videoCount + ' videos, ' + task.matchedTotal + ' intents');
      if (_completeCallback) {
        try { _completeCallback({ success: true, reason: 'user_stopped', matchedTotal: task.matchedTotal, videoCount: task.videoCount }); }
        catch (err) { logger.warn('onComplete user_stopped error: ' + err.message); }
        _completeCallback = null;
      }
    } else {
      log('✅ Recommend browse completed! Total browsed ' + task.videoCount + ' videos, ' + task.matchedTotal + ' intents');
      if (_completeCallback) {
        try { _completeCallback({ success: true, reason: 'finished', matchedTotal: task.matchedTotal, videoCount: task.videoCount }); }
        catch (err) { logger.warn('onComplete finished error: ' + err.message); }
        _completeCallback = null;
      }
    }
  } catch (e) {
    log('❌ Recommend browse failed: ' + e.message);
    logger.error('Recommend browse error: ' + e.message + '\n' + e.stack);
    getStateMachine().setError(e.message, { category: 'runtime' });
    if (_completeCallback) {
      try { _completeCallback({ success: false, reason: 'error', message: e.message }); }
      catch (err) { logger.warn('onComplete error error: ' + err.message); }
      _completeCallback = null;
    }
  } finally {
    recommendRunning = false;
    recommendPaused = false;
    currentTask = null;
    const state = getStateMachine();
    if (state.current === STATES.SEARCHING || state.current === STATES.PAUSED) {
      state.transition(STATES.IDLE, { phase: 'completed' });
    }
  }
}

// ========== Navigate to recommend page ==========

async function navigateToRecommend(view) {
  const wc = view.webContents;
  const currentUrl = wc.getURL();

  // ★ 修复：https://www.douyin.com/ 会重定向到 /jingxuan（精选页），没有feed-active-video
  // 必须使用 ?recommend=1 才能进入推荐流
  if (currentUrl.includes('recommend=1') && !currentUrl.includes('/search') && !currentUrl.includes('/video/') && !currentUrl.includes('/user/')) {
    log('Already on recommend page');
    return;
  }

  log('Navigating to recommend page...');
  try {
    await wc.loadURL('https://www.douyin.com/?recommend=1&from_nav=1');
    await sleep(3000, 5000);
    // 验证是否成功进入推荐流（有feed-active-video）
    const hasFeed = await js(wc, '!!document.querySelector("[data-e2e=feed-active-video]")');
    if (!hasFeed) {
      log('  Recommend feed not detected, waiting more...');
      await sleep(3000, 5000);
    }
    log('Navigated to recommend page');
  } catch (e) {
    log('Navigation failed: ' + e.message);
  }
}

// ========== Check login ==========

async function checkLogin(view) {
  const wc = view.webContents;
  const body = await js(wc, 'document.body.innerText.substring(0,300)') || '';
  if (body.includes('login') && body.length < 100) {
    log('Please login to Douyin...');
    for (let i = 0; i < 120; i++) {
      if (!await wait(3000)) return;
      const b = await js(wc, 'document.body.innerText.substring(0,300)') || '';
      if (!b.includes('login') || b.length > 100) { log('Login successful'); break; }
    }
  }
}

// ========== Get current feed video ==========

async function getCurrentFeedVideo(view) {
  return await dom.getCurrentVideoInfo(view);
}

// ========== Description extractor ==========

var __DESC_B64__ = 'KGZ1bmN0aW9uKCl7dmFyIGFjdGl2ZVZpZGVvID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtZTJlPSJmZWVkLWFjdGl2ZS12aWRlbyJdJyk7aWYoYWN0aXZlVmlkZW8pe3ZhciBjb250YWluZXIgPSBhY3RpdmVWaWRlby5jbG9zZXN0KCdbY2xhc3M6PSJjb250YWluZXJdJykgfHwgYWN0aXZlVmlkZW8ucGFyZW50RWxlbWVudDtpbihjb250YWluZXIpe3ZhciIHNwYW5zID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoJ3NwYW4sIHAsIGRpdicpO2Zvcih2YXIgaT0wO2k8c3BhbnMubGVuZ3RoO2krKyl7dmFyIHQ9KHNwYW5zW2ldLmlubmVyVGV4dHx8JycpLnRyaW0oKTtpZih0Lmxlbmd0aD4xMCAmJiB0Lmxlbmd0aDw1MDApe2lmIS9eXGQrJC8udGVzdCh0KSAmJiAodC5pbmRleE9mKCcjJyk+PTAgfHwgdC5sZW5ndGg+MjApKXtyZXR1cm4gdDt9fX192YXIgZGVzY0VscyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWUyZT0iZmVlZC1kZXNjIl0sIFtjbGFzcyo9ImRlc2MiXSwgW2NsYXNzKj0iY2FwdGlvbiJdJyk7Zm9yKHZhciBpPTA7aTxkZXNjRWxzLmxlbmd0aDtpKyspe3ZhciHR0PShkZXNjRWxbbV0uaW5uZXJUZXh0fHwnJyksdHJpbSgpO2lmKHR0Lmxlbmd0aD41ICYmIHR0Lmxlbmd0aDw1MDApIHJldHVybiB0dDt9dmFyIGhhc2hUYWdzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnYVtocmVmKj0iL3NlYXJjaC8iXScpO3ZhciBwYXJ0cz1bXTtmb3IodmFyIGk9MDtpaGhhc2hUYWdzLmxlbmd0aDtpKyspe3ZhciHQ9KGhhc2hUYWdzW2ldLmlubmVyVGV4dHx8JycpLnRyaW0oKTtpZih0ICYmIHQubGVuZ3RoPDUwKSBwYXJ0cy5wdXNoKHQpO31pZihwYXJ0cy5sZW5ndGg+MCkgcmV0dXJuIHBhcnRzLmpvaW4oJyAnKTtyZXR1cm4gJyc7fSkoKQ==';

function getDescriptionScript() {
  return Buffer.from(__DESC_B64__, 'base64').toString('utf8');
}

async function extractVideoDesc(view) {
  const wc = view.webContents;
  // ★ 修复：优先用 [data-e2e=video-desc] 获取描述，这是最可靠的方式
  return await js(wc, `(function(){
    var av = document.querySelector('[data-e2e="feed-active-video"]');
    if (!av) return '';
    // 策略1: data-e2e=video-desc
    var desc = av.querySelector('[data-e2e="video-desc"]');
    if (desc) return (desc.innerText || '').trim();
    // 策略2: class含desc/caption
    var descEls = av.querySelectorAll('[class*="desc"], [class*="caption"]');
    for (var i = 0; i < descEls.length; i++) {
      var t = (descEls[i].innerText || '').trim();
      if (t.length > 5 && t.length < 500) return t;
    }
    // 策略3: 查找包含#的话题标签
    var hashTags = av.querySelectorAll('a[href*="/search/"]');
    var parts = [];
    for (var i = 0; i < hashTags.length; i++) {
      var t = (hashTags[i].innerText || '').trim();
      if (t && t.length < 50) parts.push(t);
    }
    if (parts.length > 0) return parts.join(' ');
    return '';
  })()`) || '';
}

// ========== Match video keywords ==========

function matchVideoKeywords(desc, videoKeywords) {
  if (!desc || !Array.isArray(videoKeywords) || videoKeywords.length === 0) {
    return { hit: false, keywords: [] };
  }

  const matched = [];
  for (const kw of videoKeywords) {
    if (!kw) continue;
    const norm = match.normalizeText(kw);
    const normDesc = match.normalizeText(desc);
    if (norm && normDesc.includes(norm)) {
      matched.push(kw);
    }
  }

  return { hit: matched.length > 0, keywords: matched };
}

// ========== Slide to next video ==========

async function swipeNextVideo(wc) {
  const x = rand(300, 600);
  const startY = rand(500, 600);
  const endY = rand(150, 250);

  try {
    await human.mouseMove(wc, x, startY);
    await sleep(100, 200);
    await wc.sendInputEvent({ type: 'mouseDown', x, y: startY, button: 'left' });
    await sleep(50, 100);
    const steps = rand(5, 10);
    const dy = (endY - startY) / steps;
    for (let i = 1; i <= steps; i++) {
      await wc.sendInputEvent({ type: 'mouseMove', x, y: startY + dy * i, button: 'left' });
      await sleep(15, 30);
    }
    await wc.sendInputEvent({ type: 'mouseUp', x, y: endY, button: 'left' });
  } catch (e) {
    try { await human.keyPress(wc, 'ArrowDown'); } catch (_) {}
  }
}

// Profile script (stored base64 to avoid nested escape issues)
var __PROF_B64__ = 'KGZ1bmN0aW9uKCl7dmFyIGluZm89e2F1dGhvcjonJyxwcm9maWxlVXJsOid9O3ZhciBsaW5rcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdhW2hyZWYqPSIvdXNlci8iXScpO2Zvcih2YXIgaT0wO2k8bGlua3MubGVuZ3RoO2krKyl7dmFyIHI9bGlua3NbaV0uZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7aWYoci53aWR0aD41ICYmIHIuaGVpZ2h0PjUpe3ZhciIGhyZWY9bGlua3NbaV0uZ2V0QXR0cmlidXRlKCdocmVmJyl8fCcnO3ZhciIG5hbWU9KGxpbmtzW2ldLmlubmVyVGV4dHx8JycpLnRyaW0oKS5yZXBsYWNlKC9eQC8sJycpO2lmKG5hbWUubGVuZ3RoPjAgJiYgbmFtZS5sZW5ndGg8MzApe2luZm8uYXV0aG9yPW5hbWU7aW5mby5wcm9maWxlVXJsPWhyZWYuc3RhcnRzV2l0aCgnaHR0cCcpP2hyZWY6KGhyZWYuc3RhcnRzV2l0aCgnLycpPydodHRwczovL3d3dy5kb3V5aW4uY29tJytocmVmOidodHRwczovL3d3dy5kb3V5aW4uY29tLycraHJlZik7YnJlYWs7fX1yZXR1cm4gaW5mbzt9KSgp';
function profileScript() { return Buffer.from(__PROF_B64__, 'base64').toString('utf8'); }

// Profile script (stored base64 to avoid nested escape issues)
var __PROF_B64__ = 'KGZ1bmN0aW9uKCl7dmFyIGluZm89e2F1dGhvcjonJyxwcm9maWxlVXJsOid9O3ZhciBsaW5rcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdhW2hyZWYqPSIvdXNlci8iXScpO2Zvcih2YXIgaT0wO2k8bGlua3MubGVuZ3RoO2krKyl7dmFyIHI9bGlua3NbaV0uZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7aWYoci53aWR0aD41ICYmIHIuaGVpZ2h0PjUpe3ZhciIGhyZWY9bGlua3NbaV0uZ2V0QXR0cmlidXRlKCdocmVmJyl8fCcnO3ZhciIG5hbWU9KGxpbmtzW2ldLmlubmVyVGV4dHx8JycpLnRyaW0oKS5yZXBsYWNlKC9eQC8sJycpO2lmKG5hbWUubGVuZ3RoPjAgJiYgbmFtZS5sZW5ndGg8MzApe2luZm8uYXV0aG9yPW5hbWU7aW5mby5wcm9maWxlVXJsPWhyZWYuc3RhcnRzV2l0aCgnaHR0cCcpP2hyZWY6KGhyZWYuc3RhcnRzV2l0aCgnLycpPydodHRwczovL3d3dy5kb3V5aW4uY29tJytocmVmOidodHRwczovL3d3dy5kb3V5aW4uY29tLycraHJlZik7YnJlYWs7fX1yZXR1cm4gaW5mbzt9KSgp';
function profileScript() { return Buffer.from(__PROF_B64__, 'base64').toString('utf8'); }

// ========== Process recommend page video (after keyword hit) ==========

async function processRecommendVideo(ctx) {
  const { view, aid, desc, matchedVideoKeywords, keywords, cdp, shouldContinue, onResult, onLog, maxComments, cutoffTs, commentHours = 60, commentSort, onProgress } = ctx;
  const wc = view.webContents;
  const videoInfo = {
    aweme_id: aid,
    desc: desc || '',
    author: '',
    video_url: 'https://www.douyin.com/video/' + aid
  };
  const result = { matched: 0, cdp: 0, dom: 0, effective: 0, skipped: '' };
  const check = function() { return shouldContinue ? shouldContinue() : true; };
  const _log = function(msg) { logger.info(msg); if (onLog) onLog(msg); };

  try {
    // ===== 1. Simulate watching video =====
    _log('  1. Watching video...');
    await human.mouseMove(wc, rand(300, 700), rand(200, 400));
    if (!await wait(3000, 6000)) { result.skipped = 'interrupted'; return result; }

    // ===== 2. Detect comment count =====
    _log('  2. Detecting comment count...');
    const commentCount = await dom.getCommentCount(view);
    _log('     Comment count: ' + (commentCount === -1 ? 'unknown' : commentCount));

    // Key logic fix: trust numeric priority
    // - if commentCount > 0: definitely has comments, enter comment section
    // - if commentCount === 0: confirm "抢首评", skip
    // - if commentCount === -1: number unknown, further check with checkFirstComment
    if (commentCount > 0) {
      _log('     ' + commentCount + ' comments detected, entering comment section');
    } else if (commentCount === 0) {
      _log('     "first comment" state detected, 0 comments, skipping comment section');
      result.skipped = 'no comments';
      return result;
    } else {
      // commentCount === -1 (unknown), further check
      const hasFirstComment = await checkFirstComment(wc);
      if (hasFirstComment) {
        _log('     "first comment" state detected, 0 comments, skipping comment section');
        result.skipped = 'no comments';
        return result;
      }
      _log('     Comment count unknown, trying to open comment section to confirm');
    }

    // ===== 3. Open comment section (click icon + X-key double safety) =====
    _log('  3. Opening comment section...');
    if (cdp) cdp.beginCollect(aid);

    let commentOpen = false;
    for (let attempt = 0; attempt < 3 && !commentOpen; attempt++) {
      if (attempt > 0) {
        _log('     Comment section not opened, retry ' + attempt + ' (method ' + (attempt % 2 === 0 ? 'icon' : 'X') + ')...');
        if (!shouldContinue || !shouldContinue()) return { ...result, skipped: 'interrupted' };
        await sleep(500, 1000);
      }
      if (attempt === 0 || attempt === 2) {
        const clickResult = await dom.openCommentPanel(view);
        if (clickResult && clickResult.ok) {
          _log('     Icon click successful (' + clickResult.selector + ') @(' + clickResult.x + ',' + clickResult.y + ')');
        }
      } else {
        await human.keyPress(wc, 'x');
      }
      if (!await wait(2000, 3500)) return { ...result, skipped: 'interrupted' };
      commentOpen = await dom.isCommentOpen(view);
    }

    if (!commentOpen) {
      _log('     Comment section not opened, skipping');
      result.skipped = 'comment section not opened';
      if (cdp) { try { cdp.endCollect(aid); } catch(_) {} }
      await exitVideo(wc, check);
      return result;
    }
    _log('     Comment section opened');

    // Enhancement: try switching comment sort mode (per user preset: newest/hottest/default)
    const defaultSortMode = cutoffTs > 0 ? 'newest' : 'hottest';
    const effectiveSortMode = commentSort || defaultSortMode;
    _log('     Comment sort preset: ' + (commentSort ? 'user-specified=' + commentSort : 'auto=' + defaultSortMode));
    const sortSwitched = await dom.trySwitchCommentSort(view, effectiveSortMode);
    if (sortSwitched) {
      _log('     Switched comment sort (mode: ' + effectiveSortMode + ')');
      if (!await wait(1500, 2500)) return { ...result, skipped: 'interrupted' };
    } else {
      _log('     No sort switch option detected or using default sort (mode: ' + effectiveSortMode + ')');
    }

    // ===== 4. Scroll to load comments (JS-driven + state verification + time-driven) =====
    _log('  4. Browsing comment section (target: ' + maxComments + ', time mode: ' + (cutoffTs > 0 ? 'yes' : 'no') + ')...');
    _log('     User params: commentHours=' + commentHours + 'h, cutoffTs=' + cutoffTs + ', maxComments=' + maxComments);
    if (cutoffTs > 0) {
      const now = Math.floor(Date.now() / 1000);
      const hoursAgo = Math.round((now - cutoffTs) / 3600);
      _log('     Time mode: only keep comments from the last ' + hoursAgo + ' hours, stop scrolling on 5 consecutive expired entries');
    } else {
      _log('     Quantity mode: no time limit, only scroll-collect by quantity upper bound');
    }

    if (cdp) cdp.beginCollect(aid);

    let targetScrolls;
    let minRoundsForRetry;
    if (commentCount === -1) {
      targetScrolls = Math.ceil(maxComments / 5);
      minRoundsForRetry = 3;
    } else {
      const targetCount = Math.min(commentCount, maxComments);
      targetScrolls = Math.min(Math.ceil(targetCount / 5), 30);
      minRoundsForRetry = commentCount < 20 ? 2 : 3;
    }

    _log('     ' + (commentCount === -1 ? 'unknown' : commentCount) + ' comments, need ' + targetScrolls + ' scrolls, stop after ' + minRoundsForRetry + ' rounds with no new comments');

    let loadedCount = 0;
    let noNewCount = 0;
    let expiredStreak = 0;
    const EXPIRED_THRESHOLD = 5;
    let lastCheckedCount = 0;
    const startTime = Date.now();
    const MAX_DURATION_MS = Math.min(5 * 60 * 1000, maxComments * 8000);
    _log('     Total timeout: ' + Math.round(MAX_DURATION_MS / 1000) + ' seconds');

    for (let i = 0; i < targetScrolls; i++) {
      if (!check()) {
        _log('     Task paused/stopped, exit scrolling');
        break;
      }
      if (Date.now() - startTime > MAX_DURATION_MS) {
        _log('     Scroll timeout, exit scrolling');
        break;
      }

      // Scroll verification: still in comment section, still on current video
      const commentStillOpen = await dom.isCommentOpen(view);
      if (!commentStillOpen) {
        _log('     Comment section closed, stop scrolling');
        break;
      }
      const currentAid = await dom.getCurrentVideoId(view);
      if (currentAid && aid && currentAid !== aid) {
        _log('     Video switched (' + currentAid + ' != ' + aid + '), stop scrolling and exit');
        break;
      }

      // BUG fix: known small-comment-count videos, stop as soon as all loaded
      if (commentCount > 0 && commentCount < 20 && loadedCount >= commentCount) {
        _log('     All ' + loadedCount + ' comments loaded (known ' + commentCount + '), stop scrolling');
        break;
      }

      const beforeCount = cdp ? cdp.getComments(aid).length : 0;
      // Move mouse only within comment area (avoid accidentally touching video area)
      const viewport = await wc.executeJavaScript('({ w: window.innerWidth, h: window.innerHeight })').catch(function() { return { w: 800, h: 600 }; });
      if (viewport && viewport.w) {
        const safeX = Math.round(viewport.w * 0.6 + Math.random() * viewport.w * 0.3);
        const safeY = rand(200, Math.min(viewport.h - 100, 800));
        await human.mouseMove(wc, safeX, safeY);
      } else {
        await human.mouseMove(wc, rand(600, 900), rand(300, 600));
      }
      await dom.scrollCommentPanel(view, 1, 300);
      await sleep(1500, 2500);

      const afterCount = cdp ? cdp.getComments(aid).length : 0;
      loadedCount = afterCount;
      if (afterCount > beforeCount) {
        noNewCount = 0;
        if (i % 3 === 0) _log('     Scroll ' + (i + 1) + '/' + targetScrolls + ' loaded ' + afterCount + ' (+' + (afterCount - beforeCount) + ')');

        // Timeliness check (if cutoffTs)
        if (cutoffTs > 0) {
          const allCdpComments = cdp.getComments(aid);
          let shouldStop = false;
          for (let ci = lastCheckedCount; ci < allCdpComments.length; ci++) {
            const ct = allCdpComments[ci].create_time || 0;
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
            _log('     ' + expiredStreak + ' consecutive expired comments out of time range, stop loading');
            break;
          }
        }
      } else {
        noNewCount++;
      }

      if (afterCount >= maxComments) {
        _log('     Loaded ' + afterCount + ' >= target ' + maxComments);
        break;
      }
      // Dynamically adjust stop threshold for no-new-comments based on comment count
      if (noNewCount >= minRoundsForRetry) {
        _log('     ' + minRoundsForRetry + ' consecutive rounds with no new comments, may have reached bottom, stop scrolling');
        break;
      }

      // Occasionally pause to simulate reading (only when there are a certain number of comments)
      if (commentCount === -1 || commentCount >= 20) {
        if (Math.random() < 0.2) {
          if (!check()) break;
          await sleep(2000, 5000);
        }
      }
    }

    await wait(2000, 3000);
    if (!check()) { result.skipped = 'interrupted'; return result; }

    // ===== 5. Collect comments =====
    _log('  5. Collecting comments...');
    const cdpComments = cdp ? cdp.getComments(aid) : [];
    const domComments = await dom.readDomComments(view);

    // ★ 修复：authorInfo 未定义导致崩溃，用 profileScript 获取作者信息
    const authorInfo = await js(wc, profileScript()) || { author: '', profileUrl: '' };
    videoInfo.author = authorInfo.author || '';
    if (authorInfo.profileUrl) videoInfo.authorProfile = authorInfo.profileUrl;

    // Merge comments (add: strict time filtering to ensure expired comments are not mistakenly retained)
    const cdpMap = [];
    let cdpExpired = 0;
    let cdpNoTime = 0;
    for (const c of cdpComments) {
      const text = (c.text || '').trim();
      if (!text) continue;
      const ct = c.create_time || 0;
      if (cutoffTs > 0) {
        if (ct > 0 && ct < cutoffTs) {
          cdpExpired++;
          continue;
        }
        if (ct === 0) {
          cdpNoTime++;
        }
      }
      cdpMap.push({ text: text, comment: c });
    }
    const domMap = [];
    let domExpired = 0;
    let domNoTime = 0;
    const seenTexts = new Set();
    for (const d of domComments) {
      const text = (d.text || '').trim();
      if (!text) continue;
      if (seenTexts.has(text)) continue;
      seenTexts.add(text);
      const dt = d.create_time || 0;
      // Key fix: DOM comments also need time filtering (was completely missing!)
      if (cutoffTs > 0) {
        if (dt > 0 && dt < cutoffTs) {
          domExpired++;
          continue;
        }
        if (dt === 0) {
          // Time unknown: try looking for corresponding CDP comment to judge
          const cdpMatch = cdpComments.find(function(c) { return (c.text || '').trim() === text; });
          if (cdpMatch && cdpMatch.create_time > 0 && cdpMatch.create_time < cutoffTs) {
            domExpired++;
            continue;
          }
          domNoTime++;
        }
      }
      domMap.push({ text: text, comment: d });
    }
    const allTexts = new Set([...cdpMap.map(function(x) { return x.text; }), ...domMap.map(function(x) { return x.text; })]);
    const allComments = [];
    for (const text of allTexts) {
      const cdpMatch = cdpMap.find(function(x) { return x.text === text; });
      const domMatch = domMap.find(function(x) { return x.text === text; });
      allComments.push({ cdp: cdpMatch ? cdpMatch.comment : null, dom: domMatch ? domMatch.comment : null });
    }

    result.effective = allComments.length;
    result.cdp = cdpMap.length;
    result.dom = domMap.length;
    _log('     CDP:' + cdpMap.length + '(expired ' + cdpExpired + '/no-time ' + cdpNoTime + ') DOM:' + domMap.length + '(expired ' + domExpired + '/no-time ' + domNoTime + ') effective:' + allComments.length + ' cutoffTs=' + cutoffTs);

    if (allComments.length === 0) {
      result.skipped = 'no valid comments';
      if (cdp) cdp.endCollect(aid);
      await closeCommentAndExit(wc, check);
      return result;
    }

    // ===== 6. Match keywords =====
    _log('  6. Matching intent keywords...');
    let matched = 0;
    for (const pair of allComments) {
      if (!check()) break;
      const r = pipeline.processComment(pair.cdp, pair.dom, videoInfo, keywords, { cutoffTs: cutoffTs, commentHours: commentHours });
      if (r) {
        // Mark video keyword source
        r.video_keywords = matchedVideoKeywords;
        matched++;
        if (onResult) onResult(r);
      }
    }
    result.matched = matched;

    // ===== 7. Close comment section =====
    if (cdp) cdp.endCollect(aid);
    await closeCommentAndExit(wc, check);

    return result;
  } catch (e) {
    _log('  Processing error: ' + e.message);
    if (cdp) try { cdp.endCollect(aid); } catch (_) {}
    try { await exitVideo(wc, check); } catch (_) {}
    result.skipped = e.message;
    return result;
  }
}

// Script helpers (base64 to avoid nested string escape issues)
var __FC_B64__ = 'KGZ1bmN0aW9uKCl7dmFyIGFjdGl2ZVZpZGVvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWUyZT0iZmVlZC1hY3RpdmUtdmlkZW8iXScpO3ZhciByb290U2NvcGU9YWN0aXZlVmlkZW98fGRvY3VtZW50LmJvZHk7dmFyIGljb25TZWxlY3RvcnM9W1dbZGF0YS1lMmU9ImZlZWQtY29tbWVudC1pY29uIl0nLCdbZGF0YS1lMmU9ImNvbW1lbnQtaWNvbiJdJywnW2NsYXNzKj0iY29tbWVudCJdW2NsYXNzKj0iaWNvbiJdJ107Zm9yKHZhciBzPTA7czxpY29uU2VsZWN0b3JzLmxlbmd0aDtzKyspe3ZhciGljb249cm9vdFNjb3BlLnF1ZXJ5U2VsZWN0b3IoaWNvblNlbGVjdG9yc1tzXSk7aWYoaWNvbil7dmFyIHRhcmdldHM9W2ljb24saWNvbi5wYXJlbnRFbGVtZW50LChpY29uLnBhcmVudEVsZW1lbnQ/aWNvbi5wYXJlbnRFbGVtZW50LnBhcmVudEVsZW1lbnQ6bnVsbCldO2Zvcih2YXIgdD0wO3Q8dGFyZ2V0cy5sZW5ndGg7dCsrKXtpZighdGFyZ2V0c1t0XSljb250aW51ZTt2YXIgdHh0PSh0YXJnZXRzW3RdLmlubmVyVGV4dHx8JycpLnRyaW0oKTtpZih0eHQuaW5kZXhPZign5pS26aaW56KSA+PTApcmV0dXJuIHRydWU7fX19aWYoYWN0aXZlVmlkZW8pe3ZhciIHJlbGF0ZWQ9YWN0aXZlVmlkZW8ucXVlcnlTZWxlY3RvcignW2NsYXNzKj0iY29tbWVudCJdJyk7aWYocmVsYXRlZCAmJiAocmVsYXRlZC5pbm5lclRleHR8fCcnKS5pbmRleE9mKCflpLrpppnoKSA+PTApcmV0dXJuIHRydWU7fXJldHVybiBmYWxzZTt9KSgp';
var __SC_B64__ = 'KGZ1bmN0aW9uKCl7dmFyIGVsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyN2aWRlb1NpZGVDYXJkJyk7cmV0dXJuIGVsP2VsLmNsaWVudFdpZHRoPjA6ZmFsc2U7fSkoKQ==';
function checkFirstCommentScript() { return Buffer.from(__FC_B64__, 'base64').toString('utf8'); }
function sideCardScript() { return Buffer.from(__SC_B64__, 'base64').toString('utf8'); }

// Script helpers (base64 to avoid nested string escape issues)
var __FC_B64__ = 'KGZ1bmN0aW9uKCl7dmFyIGFjdGl2ZVZpZGVvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWUyZT0iZmVlZC1hY3RpdmUtdmlkZW8iXScpO3ZhciByb290U2NvcGU9YWN0aXZlVmlkZW98fGRvY3VtZW50LmJvZHk7dmFyIGljb25TZWxlY3RvcnM9W1dbZGF0YS1lMmU9ImZlZWQtY29tbWVudC1pY29uIl0nLCdbZGF0YS1lMmU9ImNvbW1lbnQtaWNvbiJdJywnW2NsYXNzKj0iY29tbWVudCJdW2NsYXNzKj0iaWNvbiJdJ107Zm9yKHZhciBzPTA7czxpY29uU2VsZWN0b3JzLmxlbmd0aDtzKyspe3ZhciGljb249cm9vdFNjb3BlLnF1ZXJ5U2VsZWN0b3IoaWNvblNlbGVjdG9yc1tzXSk7aWYoaWNvbil7dmFyIHRhcmdldHM9W2ljb24saWNvbi5wYXJlbnRFbGVtZW50LChpY29uLnBhcmVudEVsZW1lbnQ/aWNvbi5wYXJlbnRFbGVtZW50LnBhcmVudEVsZW1lbnQ6bnVsbCldO2Zvcih2YXIgdD0wO3Q8dGFyZ2V0cy5sZW5ndGg7dCsrKXtpZighdGFyZ2V0c1t0XSljb250aW51ZTt2YXIgdHh0PSh0YXJnZXRzW3RdLmlubmVyVGV4dHx8JycpLnRyaW0oKTtpZih0eHQuaW5kZXhPZign5pS26aaW56KSA+PTApcmV0dXJuIHRydWU7fX19aWYoYWN0aXZlVmlkZW8pe3ZhciIHJlbGF0ZWQ9YWN0aXZlVmlkZW8ucXVlcnlTZWxlY3RvcignW2NsYXNzKj0iY29tbWVudCJdJyk7aWYocmVsYXRlZCAmJiAocmVsYXRlZC5pbm5lclRleHR8fCcnKS5pbmRleE9mKCflpLrpppnoKSA+PTApcmV0dXJuIHRydWU7fXJldHVybiBmYWxzZTt9KSgp';
var __SC_B64__ = 'KGZ1bmN0aW9uKCl7dmFyIGVsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyN2aWRlb1NpZGVDYXJkJyk7cmV0dXJuIGVsP2VsLmNsaWVudFdpZHRoPjA6ZmFsc2U7fSkoKQ==';
function checkFirstCommentScript() { return Buffer.from(__FC_B64__, 'base64').toString('utf8'); }
function sideCardScript() { return Buffer.from(__SC_B64__, 'base64').toString('utf8'); }

// ========== Detect "抢首评" (first comment state) ==========
// Key fix: only detect near the comment icon, to avoid interference from "抢首评" text elsewhere on the page
async function checkFirstComment(wc) {
  try {
    const r = await wc.executeJavaScript(checkFirstCommentScript());
    return r === true;
  } catch (_) {
    return false;
  }
}

// ========== Close comment section + exit video ==========

async function closeCommentAndExit(wc, shouldContinue) {
  // First ensure comment section is closed
  try {
    const commentOpen = await wc.executeJavaScript(sideCardScript()).catch(function() { return false; });
    if (commentOpen) {
      await human.keyPress(wc, 'x');
      if (!shouldContinue || (shouldContinue && !shouldContinue())) return;
      await sleep(800, 1500);
      const stillOpen = await wc.executeJavaScript(sideCardScript()).catch(function() { return false; });
      if (stillOpen) {
        try {
          const vp = await wc.executeJavaScript('({ w: window.innerWidth, h: window.innerHeight })').catch(function() { return { w: 800, h: 600 }; });
          await human.mouseMove(wc, Math.round(vp.w * 0.2), Math.round(vp.h * 0.5));
          await human.humanClick(wc, Math.round(vp.w * 0.2), Math.round(vp.h * 0.5));
          if (!shouldContinue || (shouldContinue && !shouldContinue())) return;
          await sleep(500, 1000);
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Simulate browsing then exit
  if (shouldContinue && !shouldContinue()) return;
  await sleep(2000, 3000);
  await human.mouseMove(wc, rand(200, 600), rand(200, 500));
  await exitVideo(wc, shouldContinue);
}

async function exitVideo(wc, shouldContinue) {
  // First ensure comment section is closed
  try {
    const commentOpen = await wc.executeJavaScript(sideCardScript()).catch(function() { return false; });
    if (commentOpen) {
      await human.keyPress(wc, 'x');
      if (!shouldContinue || (shouldContinue && !shouldContinue())) return;
      await sleep(800, 1500);
      // 验证评论区是否已关闭
      const stillOpen = await wc.executeJavaScript(sideCardScript()).catch(function() { return false; });
      if (stillOpen) {
        await human.keyPress(wc, 'Escape');
        if (!shouldContinue || (shouldContinue && !shouldContinue())) return;
        await sleep(500, 1000);
      }
    }
  } catch (_) {}

  // ★ 推荐页是弹窗形式，不需要退出视频详情页
  // 只需关闭评论区即可，滑动到下一个视频由主循环的 swipeNextVideo 处理
  if (!shouldContinue || (shouldContinue && !shouldContinue())) return;
  await sleep(1000, 2000);
}

// ========== Utilities ==========

async function js(wc, s, timeoutMs) {
  const ms = timeoutMs || 15000;
  try {
    return await Promise.race([
      wc.executeJavaScript(s),
      new Promise(function(_, reject) { setTimeout(function() { reject(new Error('js_timeout')); }, ms); })
    ]);
  } catch (e) {
    if (e && e.message === 'js_timeout') {
      logger.warn('[Recommend] js timeout (' + ms + 'ms): ' + s.substring(0, 80));
    }
    return null;
  }
}
function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }

/**
 * Interruptible sleep (responds to pause/stop)
 */
function sleep(a, b) {
  const ms = b ? rand(a, b) : a;
  return new Promise(function(resolve) {
    const start = Date.now();
    const check = function() {
      const elapsed = Date.now() - start;
      if (elapsed >= ms) return resolve();
      try {
        const vp = require('./videoProcessor');
        if (typeof vp._isInterrupted === 'function' && vp._isInterrupted()) return resolve();
      } catch(_) {}
      try {
        if (!recommendRunning) return resolve();
        if (recommendPaused) {
          const resumeCheck = setInterval(function() {
            try {
              const vp = require('./videoProcessor');
              if (typeof vp._isInterrupted === 'function' && vp._isInterrupted()) { clearInterval(resumeCheck); return resolve(); }
            } catch(_) {}
            if (!recommendRunning) { clearInterval(resumeCheck); return resolve(); }
            if (!recommendPaused) { clearInterval(resumeCheck); check(); }
          }, 500);
          return;
        }
      } catch(_) {}
      setTimeout(check, Math.min(300, ms - elapsed));
    };
    setTimeout(check, Math.min(300, ms));
  });
}
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

module.exports = { startRecommend: startRecommend, stopRecommend: stopRecommend, pauseRecommend: pauseRecommend, isRunning: isRunning, isPaused: isPaused };
