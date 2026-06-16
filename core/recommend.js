/**
 * 推荐页浏览模块
 *
 * 功能：
 *   1. 自动播放浏览抖音推荐页
 *   2. 识别视频文案+话题，匹配视频关键词
 *   3. 符合关键词的视频 → 打开评论区 → 模拟浏览 → 加载时效评论 → 采集需求信息
 *   4. 支持设定任务结束时间
 *   5. 循环播放浏览，直到任务结束
 *
 * 独立模块，不依赖 search/monitor 模块
 */

const { getDouyinView } = require('../main/window');
const { getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const dom = require('./domUtils');
const pipeline = require('./pipeline');
const match = require('./match');
const { getLogger } = require('./logger');

const logger = getLogger('RecommendEngine');

let recommendRunning = false;
let recommendPaused = false;
let logCallback = null;
let progressCallback = null;
let resultCallback = null;
let currentTask = null;

function isRunning() { return recommendRunning; }
function isPaused() { return recommendPaused; }

function stopRecommend() {
  recommendRunning = false;
  recommendPaused = false;
  if (currentTask) currentTask.stopped = true;
  log('🛑 推荐浏览已停止');
}

function pauseRecommend() {
  if (!recommendRunning) return;
  recommendPaused = !recommendPaused;
  log(recommendPaused ? '⏸ 暂停' : '▶ 继续');
}

// ========== 可中断等待 ==========

async function wait(min, max) {
  const total = max ? rand(min, max) : min;
  const step = 300;
  for (let t = 0; t < total; t += step) {
    if (!recommendRunning) return false;
    if (recommendPaused) {
      log('⏸ 已暂停');
      while (recommendPaused) { await sleep(300); if (!recommendRunning) return false; }
      log('▶ 已恢复');
    }
    await sleep(step);
  }
  return true;
}

// ========== 主流程 ==========

/**
 * 启动推荐页浏览
 * @param {object} params - { videoKeywords, commentHours, maxComments, endTime }
 * @param {function} onLog - 日志回调
 * @param {function} onResult - 命中结果回调
 * @param {function} onProgress - 进度回调
 */
async function startRecommend(params, onLog, onResult, onProgress) {
  if (recommendRunning) return;
  recommendRunning = true;
  recommendPaused = false;
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
    endTime: params.endTime || 0 // 时间戳，0=不限制
  };
  currentTask = task;

  const videoKeywords = params.videoKeywords || [];
  const commentHours = params.commentHours || 60;
  const maxComments = params.maxComments || 200;
  const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 3600;

  log(`🚀 启动推荐页浏览 | 关键词: ${videoKeywords.join(', ')} | 评论时效: ${commentHours}小时内`);
  if (task.endTime) {
    const endDate = new Date(task.endTime);
    log(`⏰ 任务结束时间: ${endDate.toLocaleString()}`);
  }

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('❌ 浏览器未就绪'); return; }
    const wc = view.webContents;

    // 导航到推荐页（首页）
    await navigateToRecommend(view);

    // 检查登录
    await checkLogin(view);

    // 检查验证码
    if (await dom.hasCaptcha(view)) {
      log('⚠️ 验证码！请手动完成');
      while (await dom.hasCaptcha(view) && recommendRunning) await wait(3000);
      log('✅ 验证码已通过');
    }

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    const cdp = getCDPInterceptor();

    let scrollTry = 0;
    let sincePause = 0;
    let pauseAfter = rand(2, 5);

    // 主循环：持续浏览推荐页
    while (recommendRunning && !task.stopped) {
      // 检查任务结束时间
      if (task.endTime && Date.now() >= task.endTime) {
        log('⏰ 已到任务结束时间，停止浏览');
        break;
      }

      // 获取当前播放视频的信息
      const videoInfo = await getCurrentFeedVideo(view);

      if (!videoInfo || !videoInfo.vid) {
        scrollTry++;
        if (scrollTry > 5) {
          log('未检测到视频，尝试重新导航推荐页...');
          await navigateToRecommend(view);
          scrollTry = 0;
        }
        // 滑动到下一个视频
        await swipeNextVideo(wc);
        await wait(3000, 5000);
        continue;
      }
      scrollTry = 0;

      // 跳过已处理的视频
      if (task.processedIds.has(videoInfo.vid)) {
        await swipeNextVideo(wc);
        await wait(2000, 4000);
        continue;
      }
      task.processedIds.add(videoInfo.vid);
      task.videoCount++;

      log(`\n━━━ [${task.videoCount}] 视频 ${videoInfo.vid} ━━━`);

      // 提取视频文案+话题
      const desc = await extractVideoDesc(view);
      log(`  文案: ${(desc || '').substring(0, 80)}${(desc || '').length > 80 ? '...' : ''}`);

      // 匹配视频关键词
      const kwMatch = matchVideoKeywords(desc, videoKeywords);

      if (!kwMatch.hit) {
        log(`  关键词未命中，继续浏览`);
        // 模拟观看一段时间后滑走
        await wait(3000, 8000);
        await swipeNextVideo(wc);
        continue;
      }

      log(`  ✅ 关键词命中: ${kwMatch.keywords.join(', ')}`);

      // 命中关键词 → 打开评论区采集
      const videoResult = await processRecommendVideo({
        view,
        aid: videoInfo.vid,
        desc,
        matchedVideoKeywords: kwMatch.keywords,
        keywords: { intent: intentKw, garbage: garbageKw },
        cdp,
        shouldContinue: () => recommendRunning && !task.stopped,
        onResult,
        onLog: log,
        maxComments,
        cutoffTs,
        onProgress: (info) => {
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
        log(`  📊 本视频命中: ${videoResult.matched} 条意向评论`);
      }

      // 关闭评论区并退出视频详情
      // processRecommendVideo 内部已处理退出

      // 随机暂停（模拟真人行为）
      sincePause++;
      if (sincePause >= pauseAfter) {
        const sec = rand(10, 40);
        log(`⏸ 休息 ${sec}s...`);
        if (!await wait(sec * 1000)) break;
        sincePause = 0;
        pauseAfter = rand(2, 5);
      }

      // 滑到下一个视频
      await swipeNextVideo(wc);
      await wait(2000, 4000);
    }

    log(`✅ 推荐浏览完成！共浏览 ${task.videoCount} 个视频，${task.matchedTotal} 条意向`);
  } catch (e) {
    log(`❌ 异常: ${e.message}`);
    logger.error(`推荐浏览异常: ${e.message}\n${e.stack}`);
  } finally {
    recommendRunning = false;
    recommendPaused = false;
    currentTask = null;
  }
}

// ========== 导航到推荐页 ==========

async function navigateToRecommend(view) {
  const wc = view.webContents;
  const currentUrl = wc.getURL();

  // 如果已经在推荐页，不需要导航
  if (currentUrl.includes('douyin.com') && !currentUrl.includes('/search') && !currentUrl.includes('/video/') && !currentUrl.includes('/user/')) {
    log('已在推荐页');
    return;
  }

  log('导航到推荐页...');
  try {
    await wc.loadURL('https://www.douyin.com/');
    await sleep(3000, 5000);
    log('✅ 已导航到推荐页');
  } catch (e) {
    log(`导航失败: ${e.message}`);
  }
}

// ========== 检查登录 ==========

async function checkLogin(view) {
  const wc = view.webContents;
  const body = await js(wc, 'document.body.innerText.substring(0,300)') || '';
  if (body.includes('登录') && body.length < 100) {
    log('请登录抖音...');
    for (let i = 0; i < 120; i++) {
      if (!await wait(3000)) return;
      const b = await js(wc, 'document.body.innerText.substring(0,300)') || '';
      if (!b.includes('登录') || b.length > 100) { log('✅ 登录成功'); break; }
    }
  }
}

// ========== 获取当前 Feed 视频 ==========

async function getCurrentFeedVideo(view) {
  return await dom.getCurrentVideoInfo(view);
}

// ========== 提取视频文案+话题 ==========

async function extractVideoDesc(view) {
  const wc = view.webContents;
  return await js(wc, `(function(){
    // 1. 从当前视频容器中提取文案
    const activeVideo = document.querySelector('[data-e2e="feed-active-video"]');
    if (activeVideo) {
      // 找文案区域（通常在视频下方）
      const container = activeVideo.closest('[class*="container"]') || activeVideo.parentElement;
      if (container) {
        // 查找包含话题标签的文案
        const spans = container.querySelectorAll('span, p, div');
        for (const s of spans) {
          const t = (s.innerText || '').trim();
          // 文案通常包含 # 话题标签，长度在 10-500 之间
          if (t.length > 10 && t.length < 500) {
            // 排除纯数字、昵称等
            if (!/^\\d+$/.test(t) && (t.includes('#') || t.length > 20)) {
              return t;
            }
          }
        }
      }
    }
    // 2. 降级：查找页面上的文案区域
    const descEls = document.querySelectorAll('[data-e2e="feed-desc"], [class*="desc"], [class*="caption"]');
    for (const el of descEls) {
      const t = (el.innerText || '').trim();
      if (t.length > 5 && t.length < 500) return t;
    }
    // 3. 再降级：查找包含话题的 span
    const hashTags = document.querySelectorAll('a[href*="/search/"]');
    const parts = [];
    for (const a of hashTags) {
      const t = (a.innerText || '').trim();
      if (t && t.length < 50) parts.push(t);
    }
    if (parts.length > 0) return parts.join(' ');
    return '';
  })()`) || '';
}

// ========== 匹配视频关键词 ==========

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

// ========== 滑到下一个视频 ==========

async function swipeNextVideo(wc) {
  // 抖音推荐页用上滑切换下一个视频
  // 模拟真人上滑手势
  const x = rand(300, 600);
  const startY = rand(500, 600);
  const endY = rand(150, 250);

  try {
    await human.mouseMove(wc, x, startY);
    await sleep(100, 200);
    // 模拟按住拖动
    await wc.sendInputEvent({ type: 'mouseDown', x, y: startY, button: 'left' });
    await sleep(50, 100);
    // 分步移动（更自然）
    const steps = rand(5, 10);
    const dy = (endY - startY) / steps;
    for (let i = 1; i <= steps; i++) {
      await wc.sendInputEvent({ type: 'mouseMove', x, y: startY + dy * i, button: 'left' });
      await sleep(15, 30);
    }
    await wc.sendInputEvent({ type: 'mouseUp', x, y: endY, button: 'left' });
  } catch (e) {
    // 降级：用键盘下箭头
    try { await human.keyPress(wc, 'ArrowDown'); } catch (_) {}
  }
}

// ========== 处理推荐页视频（命中关键词后） ==========

async function processRecommendVideo(ctx) {
  const { view, aid, desc, matchedVideoKeywords, keywords, cdp, shouldContinue, onResult, onLog, maxComments, cutoffTs, onProgress } = ctx;
  const wc = view.webContents;
  const videoInfo = {
    aweme_id: aid,
    desc: desc || '',
    author: '',
    video_url: `https://www.douyin.com/video/${aid}`
  };
  const result = { matched: 0, cdp: 0, dom: 0, effective: 0, skipped: '' };
  const check = () => shouldContinue ? shouldContinue() : true;
  const _log = (msg) => { logger.info(msg); if (onLog) onLog(msg); };

  try {
    // ===== 1. 模拟观看视频 =====
    _log('  1. 观看视频...');
    await human.mouseMove(wc, rand(300, 700), rand(200, 400));
    if (!await wait(3000, 6000)) { result.skipped = '被中断'; return result; }

    // ===== 2. 检测评论数 =====
    _log('  2. 检测评论数...');
    const commentCount = await dom.getCommentCount(view);
    _log(`     评论数: ${commentCount === -1 ? '未知' : commentCount}`);

    // 检查"抢首评"
    const hasFirstComment = await checkFirstComment(wc);
    if (hasFirstComment) {
      _log('     检测到"抢首评"，跳过评论区');
      result.skipped = '无评论(抢首评)';
      return result;
    }

    if (commentCount === 0) {
      _log('     评论数=0，跳过评论区');
      result.skipped = '无评论';
      return result;
    }

    // ===== 3. 打开评论区 =====
    _log('  3. 打开评论区...');
    await human.keyPress(wc, 'x');
    if (!await wait(3000, 5000)) { result.skipped = '被中断'; return result; }

    let commentOpen = await dom.isCommentOpen(view);
    if (!commentOpen) {
      _log('     未打开，再试...');
      await human.keyPress(wc, 'x');
      if (!await wait(3000, 5000)) { result.skipped = '被中断'; return result; }
      commentOpen = await dom.isCommentOpen(view);
    }

    if (!commentOpen) {
      _log('     评论区未打开，跳过');
      result.skipped = '评论区未打开';
      return result;
    }
    _log('     评论区已打开');

    // ===== 4. 滚动加载评论 =====
    _log(`  4. 浏览评论区 (目标: ${maxComments}条)...`);

    if (cdp) cdp.beginCollect(aid);

    let targetScrolls;
    if (commentCount === -1) {
      targetScrolls = Math.ceil(maxComments / 5);
    } else {
      const targetCount = Math.min(commentCount, maxComments);
      targetScrolls = Math.min(Math.ceil(targetCount / 5), 30);
    }

    _log(`     评论${commentCount === -1 ? '未知' : commentCount}条，需滚动${targetScrolls}次`);

    let noNewCount = 0;
    for (let i = 0; i < targetScrolls; i++) {
      if (!check()) break;

      const beforeCount = cdp ? cdp.getComments(aid).length : 0;
      await human.mouseMove(wc, rand(500, 750), rand(300, 700));
      await dom.scrollCommentPanel(view, 1, 300);
      await sleep(1500, 2500);

      const afterCount = cdp ? cdp.getComments(aid).length : 0;
      if (afterCount > beforeCount) {
        noNewCount = 0;
        if (i % 3 === 0) _log(`     滚动${i + 1}/${targetScrolls} 已加载${afterCount}条`);
      } else {
        noNewCount++;
      }

      if (afterCount >= maxComments) {
        _log(`     已加载${afterCount}条 >= 目标${maxComments}条`);
        break;
      }
      if (noNewCount >= 3) {
        _log('     连续3次无新评论，可能已到底部');
        break;
      }
    }

    await wait(2000, 3000);
    if (!check()) { result.skipped = '被中断'; return result; }

    // ===== 5. 采集评论 =====
    _log('  5. 采集评论...');
    const cdpComments = cdp ? cdp.getComments(aid) : [];
    const domComments = await dom.readDomComments(view);

    // 提取视频作者信息
    const authorInfo = await wc.executeJavaScript(`
      (function(){
        const info = { author: '', profileUrl: '' };
        const userLinks = document.querySelectorAll('a[href*="/user/"]');
        for (const a of userLinks) {
          const r = a.getBoundingClientRect();
          if (r.width > 5 && r.height > 5) {
            const href = a.getAttribute('href') || '';
            const name = (a.innerText || '').trim().replace(/^@/, '');
            if (name.length > 0 && name.length < 30) {
              info.author = name;
              info.profileUrl = href.startsWith('http') ? href : (href.startsWith('/') ? 'https://www.douyin.com' + href : 'https://www.douyin.com/' + href);
              break;
            }
          }
        }
        return info;
      })()
    `).catch(() => ({ author: '', profileUrl: '' }));

    videoInfo.author = authorInfo.author || '';
    if (authorInfo.profileUrl) videoInfo.authorProfile = authorInfo.profileUrl;

    // 合并评论
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
      domMap.set(text, d);
    }
    const allTexts = new Set([...cdpMap.keys(), ...domMap.keys()]);
    const allComments = [];
    for (const text of allTexts) {
      allComments.push({ cdp: cdpMap.get(text) || null, dom: domMap.get(text) || null });
    }

    result.effective = allComments.length;
    result.cdp = cdpMap.size;
    result.dom = domMap.size;
    _log(`     CDP:${cdpMap.size} DOM:${domMap.size} 有效:${allComments.length}`);

    if (allComments.length === 0) {
      result.skipped = '无有效评论';
      if (cdp) cdp.endCollect(aid);
      await closeCommentAndExit(wc);
      return result;
    }

    // ===== 6. 匹配关键词 =====
    _log('  6. 匹配意向关键词...');
    let matched = 0;
    for (const pair of allComments) {
      if (!check()) break;
      const r = pipeline.processComment(pair.cdp, pair.dom, videoInfo, keywords);
      if (r) {
        // 标记视频关键词来源
        r.video_keywords = matchedVideoKeywords;
        matched++;
        if (onResult) onResult(r);
      }
    }
    result.matched = matched;

    // ===== 7. 关闭评论区 =====
    if (cdp) cdp.endCollect(aid);
    await closeCommentAndExit(wc);

    return result;
  } catch (e) {
    _log(`  ❌ 处理异常: ${e.message}`);
    if (cdp) try { cdp.endCollect(aid); } catch (_) {}
    try { await exitVideo(wc); } catch (_) {}
    result.skipped = e.message;
    return result;
  }
}

// ========== 检测"抢首评" ==========

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

// ========== 关闭评论区+退出视频 ==========

async function closeCommentAndExit(wc) {
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
        try {
          const vp = await wc.executeJavaScript(`({ w: window.innerWidth, h: window.innerHeight })`).catch(() => ({ w: 800, h: 600 }));
          await human.mouseMove(wc, Math.round(vp.w * 0.2), Math.round(vp.h * 0.5));
          await human.humanClick(wc, Math.round(vp.w * 0.2), Math.round(vp.h * 0.5));
          await sleep(500, 1000);
        } catch (_) {}
      }
    }
  } catch (_) {}

  await sleep(2000, 3000);
  await human.mouseMove(wc, rand(200, 600), rand(200, 500));

  try { await human.keyPress(wc, 'Escape'); } catch (_) {}
  await sleep(1500, 2500);
}

async function exitVideo(wc) {
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

  await human.mouseMove(wc, rand(200, 600), rand(200, 500));
  await sleep(2000, 3000);
  try { await human.keyPress(wc, 'Escape'); } catch (_) {}
  await sleep(1500, 2500);
}

// ========== 工具 ==========

async function js(wc, s) { try { return await wc.executeJavaScript(s); } catch (_) { return null; } }
function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }
function sleep(a, b) { const ms = b ? rand(a, b) : a; return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

module.exports = { startRecommend, stopRecommend, pauseRecommend, isRunning, isPaused };
