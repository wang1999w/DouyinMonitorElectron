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
const database = require('./database');
const { getLogger } = require('./logger');
const { getStateMachine } = require('./stateMachine');
const { getErrorAnalyzer, CATEGORIES, SEVERITY } = require('./errorAnalyzer');
const { getRecoveryManager } = require('./recovery');

const logger = getLogger('VideoProcessor');

// ⚠️ 模块级中断机制：供 search.js 停止时调用
let _globalInterrupted = false;
function setInterruptFlag(v) { _globalInterrupted = v; }
function _isInterrupted() { return _globalInterrupted; }

/**
 * 可中断 sleep：每 300ms 检查一次 shouldContinue 和 _globalInterrupted
 * @param {number} min - 最小等待毫秒
 * @param {number} max - 最大等待毫秒（可省略）
 * @param {Function} shouldContinue - 返回true=继续, false=停止
 * @returns {boolean} true=正常完成，false=被中断（停止）
 * ★ 修复：暂停时等待恢复，只有停止才返回 false
 */
async function _intSleep(min, max, shouldContinue) {
  if (typeof max === 'function') { shouldContinue = max; max = undefined; }
  const total = max ? Math.floor(Math.random() * (max - min)) + min : min;
  const step = 300;
  for (let t = 0; t < total; t += step) {
    // 停止检查
    if (_globalInterrupted) return false;
    if (shouldContinue && !shouldContinue()) {
      // ★ 区分暂停和停止：检查是否是因为暂停
      // 依次检查 search / monitor / recommend 模块的暂停状态
      const modules = ['./search', './monitor', './recommend'];
      let pausedModule = null;
      for (const modPath of modules) {
        try {
          const m = require(modPath);
          if (m.isPaused && m.isPaused() && m.isRunning && m.isRunning()) {
            pausedModule = m;
            break;
          }
        } catch(_) {}
      }
      if (pausedModule) {
        // 是暂停，不是停止 → 等待恢复
        while (pausedModule.isPaused() && pausedModule.isRunning()) {
          await new Promise(r => setTimeout(r, 300));
          if (_globalInterrupted) return false;
        }
        // 恢复后继续剩余等待
        continue;
      }
      return false;  // 真正停止
    }
    await new Promise(r => setTimeout(r, Math.min(step, total - t)));
  }
  return !(_globalInterrupted);
}

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function processVideo(ctx) {
  const { view, aid, keywords, cdp, shouldContinue, onResult, onLog, videoInfo: inputVideoInfo, cutoffTs = 0, commentHours = 60, maxComments = 200, commentSort } = ctx;
  const wc = view.webContents;
  let realAid = aid;
  // 优先使用外部传入的 videoInfo，否则创建默认值
  const videoInfo = inputVideoInfo || {
    aweme_id: aid,
    desc: '',
    author: '',
    video_url: aid.startsWith('card_') ? '' : `https://www.douyin.com/video/${aid}`
  };
  // 确保 aweme_id 正确
  if (!videoInfo.aweme_id) videoInfo.aweme_id = aid;
  if (!videoInfo.video_url) videoInfo.video_url = `https://www.douyin.com/video/${videoInfo.aweme_id}`;
  const result = { matched: 0, cdp: 0, dom: 0, effective: 0, skipped: '' };

  const check = () => shouldContinue ? shouldContinue() : true;
  const _log = (msg) => { logger.info(msg); if (onLog) onLog(msg); };
  // ⚠️ 可中断 sleep：每 300ms 检查一次 shouldContinue，响应用户暂停/停止
  const _sleep = async (min, max) => _intSleep(min, max, check);
  // ⚠️ 确保模块级中断标志被重置
  _globalInterrupted = false;
  getStateMachine().setPhase('processing_video', { currentAid: aid });

  try {
    // ★ 步骤 0: 进入视频前的页面状态检查
    const initialState = await detectPageState(wc);
    // 如果当前已有视频弹窗打开，先关闭它
    if (initialState === 'video_detail') {
      _log(`     ⚠ 当前有视频已打开，先关闭...`);
      await human.keyPress(wc, 'Escape');
      await _sleep(800, 1200);
    }

    // ===== 1. 点击视频（严格真人模拟 + 页面状态验证）=====
    _log('  1. 点击视频...');
    const clicked = await clickVideoLikeHuman(view, aid, check);
    if (!clicked) {
      result.skipped = '点击失败';
      _log(`     跳过: 无法进入视频页 ${aid}`);
      return result;
    }

    // ★ 再次验证：确保当前真的在视频详情页（最终防线）
    if (!check()) { result.skipped = '被中断'; return result; }
    const afterClickState = await detectPageState(wc);
    if (afterClickState !== 'video_detail') {
      _log(`     ⚠ 点击后不在视频页(状态:${afterClickState})，跳过该视频`);
      result.skipped = '页面状态异常';
      // 确保回到列表页
      await wc.executeJavaScript('if (history.length > 1) history.back()').catch(() => {});
      await _sleep(800, 1000);
      return result;
    }

    // ===== 2. 等待视频加载完成（事件驱动，不固定sleep） =====
    _log('  2. 等待视频加载...');
    const loaded = await waitForVideoReady(view, check);
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

    // ★ 操作前验证：确保仍在正确的视频详情页（防止自动跳转到其他视频）
    const midState = await detectPageState(wc);
    if (midState !== 'video_detail') {
      _log(`     ⚠ 页面状态异常(${midState})，跳过后续处理`);
      result.skipped = '页面状态异常';
      return result;
    }

    // ===== 3. 模拟观看视频（智能时长 + 自然鼠标行为） =====
    _log('  3. 模拟观看视频...');
    const quickCommentCount = await dom.getCommentCount(view);
    await watchVideoLikeHuman(view, quickCommentCount, check);

    if (!check()) { result.skipped = '被中断'; return result; }

    // ===== 4. 检测评论数 =====
    _log('  4. 检测评论数...');
    const commentCount = await dom.getCommentCount(view);
    _log(`     评论数: ${commentCount === -1 ? '未知' : commentCount}`);

    // ⚠️ 关键逻辑修复：优先信任数字
    // - 如果 commentCount > 0：确定有评论，进入评论区处理
    // - 如果 commentCount === 0：确认是"抢首评"，跳过
    // - 如果 commentCount === -1：数字未知，进一步用 checkFirstComment 确认
    if (commentCount > 0) {
      _log(`     检测到${commentCount}条评论，进入评论区`);
    } else if (commentCount === 0) {
      _log('     检测到"抢首评"，确认0评论，跳过评论区');
      result.skipped = '无评论(抢首评)';
      await exitVideoLikeHuman(wc, view, check);
      return result;
    } else {
      // commentCount === -1（未知），进一步检查
      const hasFirstComment = await checkFirstComment(wc);
      if (hasFirstComment) {
        _log('     检测到"抢首评"，确认0评论，跳过评论区');
        result.skipped = '无评论(抢首评)';
        await exitVideoLikeHuman(wc, view, check);
        return result;
      }
      _log('     评论数未知，尝试打开评论区确认');
    }

    // ===== 5. 打开评论区（图标点击 + X键双保险） =====
    _log('  5. 打开评论区...');
    if (cdp) cdp.beginCollect(realAid);

    let commentOpen = false;
    for (let attempt = 0; attempt < 3 && !commentOpen; attempt++) {
      if (!check()) break;
      if (attempt > 0) {
        _log(`     评论区未打开，第${attempt}次重试 (方式${attempt % 2 === 0 ? '图标' : 'X键'})...`);
        if (!await _sleep(500, 1000)) break;
      }
      // 交替使用两种方式，确保至少一种成功
      if (attempt === 0 || attempt === 2) {
        const clickResult = await dom.openCommentPanel(view);
        if (clickResult && clickResult.ok) {
          _log(`     图标点击成功 (${clickResult.selector}) @(${clickResult.x},${clickResult.y})`);
        }
      } else {
        await human.keyPress(wc, 'x');
      }
      if (!await _sleep(2000, 3500)) break;
      commentOpen = await dom.isCommentOpen(view);
    }

    if (!commentOpen) {
      _log('     评论区未打开，跳过');
      result.skipped = '评论区未打开';
      if (cdp) cdp.endCollect(realAid);
      await exitVideoLikeHuman(wc, view, check);
      return result;
    }
    _log('     评论区已打开');

    // 增强：尝试切换评论排序方式（根据用户预设参数：newest/hottest/default）
    // 时间模式推荐 newest（最新评论优先），数量模式推荐 hottest（最热评论优先）
    const defaultSortMode = cutoffTs > 0 ? 'newest' : 'hottest';
    const effectiveSortMode = commentSort || defaultSortMode;
    _log(`     评论排序预设: ${commentSort ? `用户指定=${commentSort}` : `自动=${defaultSortMode} (基于时间/数量模式)`}`);
    const sortSwitched = await dom.trySwitchCommentSort(view, effectiveSortMode);
    if (sortSwitched) {
      _log(`     ✓ 已切换评论排序 (模式: ${effectiveSortMode})`);
      if (!await _sleep(1500, 2500)) { result.skipped = '用户停止'; return result; }
    } else {
      _log(`     未检测到排序切换选项或使用默认排序 (模式: ${effectiveSortMode})`);
    }

    // ===== 6. 持续滚动加载评论（JS驱动 + 时效性驱动 + 状态验证） =====
    _log(`  6. 浏览评论区 (上限: ${maxComments}条, 时效性驱动停止)...`);
    _log(`     用户参数: commentHours=${commentHours}h, cutoffTs=${cutoffTs}, maxComments=${maxComments}`);
    if (cutoffTs > 0) {
      const now = Math.floor(Date.now() / 1000);
      const hoursAgo = Math.round((now - cutoffTs) / 3600);
      _log(`     时间模式: 只保留最近 ${hoursAgo} 小时内的评论，连续5条过期停止滚动`);
    } else {
      _log(`     数量模式: 不限制时间，只按数量上限滚动采集`);
    }

    // 先点击评论区内部获取焦点
    await focusCommentArea(view, check);
    if (!await _sleep(500, 1000)) { result.skipped = '用户停止'; return result; }

    let maxRounds;
    let minRoundsForRetry;  // 小评论数时的重试阈值
    if (commentCount === -1) {
      maxRounds = Math.ceil(maxComments / 10);
      minRoundsForRetry = 5;  // 未知评论数时，保持5轮重试
    } else {
      const targetCount = Math.min(commentCount, maxComments);
      maxRounds = Math.min(Math.ceil(targetCount / 10), 20);
      minRoundsForRetry = commentCount < 20 ? 2 : 5;  // 小评论数视频：2轮无新评论即停止
    }
    _log(`     评论${commentCount === -1 ? '未知' : commentCount}条, 上限${maxComments}条, 最大${maxRounds}轮滚动, 无新评论${minRoundsForRetry}轮后停止`);

    let loadedCount = 0;
    let noNewCount = 0;
    let expiredStreak = 0;
    const EXPIRED_THRESHOLD = 5;
    let lastCheckedCount = 0;
    const startTime = Date.now();
    const MAX_DURATION_MS = Math.min(5 * 60 * 1000, maxComments * 8000);

    _log(`     总超时: ${Math.round(MAX_DURATION_MS / 1000)}秒`);

    for (let round = 0; round < maxRounds; round++) {
      if (!check()) {
        _log('     任务已暂停/停止，退出滚动');
        break;
      }
      if (Date.now() - startTime > MAX_DURATION_MS) {
        _log('     滚动超时，退出滚动');
        break;
      }

      // ⚠️ 滚动前验证：仍在评论区、仍在当前视频
      const commentStillOpen = await dom.isCommentOpen(view);
      if (!commentStillOpen) {
        _log('     评论区已关闭，停止滚动');
        break;
      }
      const currentAid = await dom.getCurrentVideoId(view);
      if (currentAid && realAid && currentAid !== realAid) {
        _log(`     ⚠️ 视频已被切换 (${currentAid} != ${realAid})，停止滚动并退出`);
        break;
      }

      // ⚠️ BUG修复：已知小评论数视频，已加载全部则立即停止
      if (commentCount > 0 && commentCount < 20 && loadedCount >= commentCount) {
        _log(`     已加载全部${loadedCount}条评论（已知${commentCount}条），停止滚动`);
        break;
      }

      const beforeCount = cdp ? cdp.getComments(realAid).length : 0;

      // ★ 只使用 JS dispatchEvent 滚动评论区（不使用键盘快捷键！）
      const scrollTimes = rand(2, 4);
      let scrollSuccess = true;
      for (let s = 0; s < scrollTimes && scrollSuccess; s++) {
        if (!check()) break;
        await dom.scrollCommentPanel(view, 1, rand(300, 600));
        if (!await _sleep(500, 1000)) break;
      }

      // 模拟鼠标在评论区内移动（只在评论区右侧范围内移动）
      const viewport = await wc.executeJavaScript('({ w: window.innerWidth, h: window.innerHeight })').catch(() => ({ w: 800, h: 600 }));
      if (viewport && viewport.w) {
        const safeX = Math.round(viewport.w * 0.6 + Math.random() * viewport.w * 0.3);
        const safeY = rand(200, Math.min(viewport.h - 100, 800));
        await human.mouseMove(wc, safeX, safeY);
      } else {
        await human.mouseMove(wc, rand(600, 900), rand(300, 600));
      }
      if (!await _sleep(1500, 3000)) break;

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
        // ⚠️ 已知小评论数视频，不做"快速滚动"重试，直接累计计数
        const isSmallCommentVideo = commentCount > 0 && commentCount < 20;
        if (!isSmallCommentVideo && noNewCount === 1) {
          _log(`     第${round + 1}轮无新评论，尝试快速滚动...`);
          for (let k = 0; k < 5; k++) {
            if (!check()) break;
            await dom.scrollCommentPanel(view, 1, rand(500, 800));
            if (!await _sleep(300, 600)) break;
          }
          // 快速滚动后做状态验证
          const stillOpen = await dom.isCommentOpen(view);
          const currentAid2 = await dom.getCurrentVideoId(view);
          if (!stillOpen || (currentAid2 && realAid && currentAid2 !== realAid)) {
            _log('     ⚠️ 快速滚动后视频状态异常，停止加载');
            break;
          }
          if (!await _sleep(2000, 3000)) break;
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

      // ⚠️ 根据评论数动态调整无新评论停止阈值
      if (noNewCount >= minRoundsForRetry) {
        _log(`     连续${minRoundsForRetry}轮无新评论，可能已到底部，停止滚动`);
        break;
      }

      // 偶尔暂停模拟阅读（仅在有一定评论数时）
      if (commentCount === -1 || commentCount >= 20) {
        if (Math.random() < 0.2) {
          if (!check()) break;
          if (!await _sleep(2000, 5000)) break;
        }
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
      const nowSec = Math.floor(Date.now() / 1000);
      const ctSamples = cdpComments.slice(0, 3).map(c => {
        const ct = c.create_time || 0;
        const diffHours = ct > 0 ? Math.round((nowSec - ct) / 3600) : '未知';
        return `${ct}(${diffHours}h前)`;
      }).join(', ');
      _log(`     CDP评论时间样本: [${ctSamples}], now=${nowSec}, cutoffTs=${cutoffTs}`);
      
      // 增强：警告如果发现大量旧评论
      const oldCount = cdpComments.filter(c => {
        const ct = c.create_time || 0;
        return ct > 0 && cutoffTs > 0 && ct < cutoffTs;
      }).length;
      if (oldCount > 0 && oldCount === cdpComments.length) {
        _log(`     ⚠ 警告: 全部${cdpComments.length}条CDP评论均在时间范围外，可能是热门评论排序问题`);
      }
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
      videoInfo.authorProfile = videoInfo.authorProfile || cdp.currentVideo.author_profile || authorInfo.profileUrl || '';
    } else {
      // ⚠️ CDP currentVideo 与当前 realAid 不匹配（或为空），只信任 DOM 提取
      if (cdp && cdp.currentVideo) {
        logger.warn(`[VideoProcessor] CDP aweme_id(${cdp.currentVideo.aweme_id}) 与 realAid(${realAid}) 不匹配，仅使用DOM信息`);
      }
      videoInfo.desc = videoInfo.desc || authorInfo.desc || '';
      videoInfo.author = videoInfo.author || authorInfo.author || '';
      videoInfo.authorProfile = videoInfo.authorProfile || authorInfo.profileUrl || '';
    }

    // 记录视频信息到 monitor_videos 表（即使没有匹配评论也记录）
    try {
      // 严格校验：只有 CDP aweme_id === realAid 时，才使用 CDP 提供的 blogger_sec_uid
      const cdpBloggerSecUid = (cdp && cdp.currentVideo && cdp.currentVideo.aweme_id === realAid && cdp.currentVideo.author_sec_uid) || '';
      const fallbackBloggerSecUid = videoInfo.blogger_sec_uid || videoInfo.sec_uid || videoInfo.blogger || videoInfo.author || '';
      const bloggerSecUid = cdpBloggerSecUid || fallbackBloggerSecUid;

      database.addMonitorVideo({
        aweme_id: realAid,
        blogger_sec_uid: bloggerSecUid,
        desc: videoInfo.desc || '',
        create_time: (cdp && cdp.currentVideo && cdp.currentVideo.aweme_id === realAid && cdp.currentVideo.create_time) || videoInfo.create_time || Math.floor(Date.now() / 1000)
      });
    } catch (e) {
      logger.warn(`记录视频信息失败: ${e.message}`);
    }

    result.cdp = cdpComments.length;
    result.dom = domComments.length;

    // 合并 CDP + DOM 评论（新增：严格处理ct=0的情况，确保过期评论不被误保留）
    const nowSec = Math.floor(Date.now() / 1000);
    const cdpMap = new Map();
    let cdpExpired = 0;
    let cdpNoTime = 0;
    for (const c of cdpComments) {
      const text = (c.text || '').trim();
      if (!text) continue;
      const ct = c.create_time || 0;
      // ⚠️ 关键修复：ct=0 时也需要判断（但保守处理）
      if (cutoffTs > 0) {
        if (ct > 0 && ct < cutoffTs) {
          cdpExpired++;
          continue;
        }
        if (ct === 0) {
          // 时间未知：保守处理，假设是近期评论（不超过cutoffTs的1/2时间范围）
          // 但不直接过滤，后续可以根据实际情况调整
          cdpNoTime++;
        }
      }
      if (!cdpMap.has(text)) cdpMap.set(text, c);
    }
    const domMap = new Map();
    let domExpired = 0;
    let domNoTime = 0;
    for (const d of domComments) {
      const text = (d.text || '').trim();
      if (!text || domMap.has(text)) continue;
      const dt = d.create_time || 0;
      if (cutoffTs > 0) {
        if (dt > 0 && dt < cutoffTs) {
          domExpired++;
          continue;
        }
        if (dt === 0) {
          // ⚠️ 关键修复：如果DOM时间解析失败，先尝试查找CDP对应评论
          const cdpMatch = cdpComments.find(c => (c.text || '').trim() === text);
          if (cdpMatch && cdpMatch.create_time > 0 && cdpMatch.create_time < cutoffTs) {
            domExpired++;
            continue;
          }
          // 没有CDP匹配：保守保留，但标记为时间未知
          domNoTime++;
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
    _log(`     CDP:${cdpMap.size}(过期${cdpExpired}/无时间${cdpNoTime}) DOM:${domMap.size}(过期${domExpired}/无时间${domNoTime}) 有效:${allComments.length} cutoffTs=${cutoffTs}`);

    if (domComments.length > 0) {
      const domTimeDiag = domComments.slice(0, 5).map(d =>
        `${(d.text || '').slice(0, 15)}: ct=${d.create_time || 0}`
      ).join(' | ');
      _log(`     DOM时间样本: [${domTimeDiag}]`);
    }

    if (allComments.length === 0) {
      result.skipped = '无有效评论';
      if (cdp) cdp.endCollect(realAid);
      await closeCommentAndExit(wc, view, check);
      return result;
    }

    // ===== 8. 匹配关键词 + 补全抖音号 =====
    _log('  8. 匹配关键词...');
    let matched = 0;
    for (const pair of allComments) {
      if (!check()) break;
      const r = pipeline.processComment(pair.cdp, pair.dom, videoInfo, keywords, { cutoffTs, commentHours });
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
    await closeCommentAndExit(wc, view, check);

    return result;
  } catch (e) {
    const analyzed = getErrorAnalyzer().analyze(e, { aid, phase: 'process_video' });
    result.skipped = `${analyzed.category}: ${analyzed.message}`;
    if (cdp) try { cdp.endCollect(realAid); } catch(_) {}
    try { await exitVideoLikeHuman(wc, view, check); } catch(_) {}
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
 * 流程：找到卡片位置 → 鼠标移动到卡片 → 悬停 → 点击 → 验证feed-active-video出现
 * ★ 抖音搜索页点击视频后，视频以全屏弹窗形式在当前页面内打开，URL不会变
 *   正确验证方式：feed-active-video元素存在 + vid匹配目标aid
 */
async function clickVideoLikeHuman(view, aid, shouldContinue) {
  const wc = view.webContents;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (_globalInterrupted || (shouldContinue && !shouldContinue())) return false;

    // === 1. 获取卡片位置 ===
    let pos = null;
    if (aid && aid.startsWith('card_')) {
      const cardIdx = parseInt(aid.replace('card_', ''));
      pos = await wc.executeJavaScript(`(function(){
        const links = document.querySelectorAll('a[href*="/video/"]');
        const visibleLinks = [];
        for (const a of links) {
          const r = a.getBoundingClientRect();
          if (r.width > 50 && r.height > 50) visibleLinks.push({ x: r.x+r.width/2, y: r.y+r.height/2 });
        }
        if (${cardIdx} < visibleLinks.length) return visibleLinks[${cardIdx}];
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

    if (!pos) {
      logger.info(`[VideoProcessor] 第${attempt}次尝试：未找到视频卡片 ${aid}`);
      if (attempt < maxAttempts) {
        await human.mouseScroll(wc, 'down', 2);
        if (!await _intSleep(800, 1200, shouldContinue)) return false;
        continue;
      }
      return false;
    }

    // === 2. 真人操作：移动鼠标 → 悬停 → 点击 ===
    if (!await _intSleep(500, 1000, shouldContinue)) return false;
    await human.mouseMove(wc, pos.x, pos.y);
    if (!await _intSleep(200, 500, shouldContinue)) return false;
    await human.humanClick(wc, pos.x, pos.y);

    // === 3. 验证：feed-active-video出现 + vid匹配 ===
    if (!await _intSleep(1500, 2500, shouldContinue)) return false;
    const feedInfo = await wc.executeJavaScript(`(function(){
      const el = document.querySelector('[data-e2e="feed-active-video"]');
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const vid = el.getAttribute('data-e2e-vid');
      const hasVideo = !!el.querySelector('video');
      return {
        found: true,
        visible: r.width > 100 && r.height > 100,
        vid: vid,
        hasVideo: hasVideo,
        w: Math.round(r.width),
        h: Math.round(r.height)
      };
    })()`).catch(() => ({ found: false }));

    if (feedInfo.found && feedInfo.visible && feedInfo.hasVideo) {
      // vid匹配检查（card_类型不检查vid）
      if (aid.startsWith('card_') || !feedInfo.vid || feedInfo.vid === aid) {
        logger.info(`[VideoProcessor] ✓ 点击成功，视频已打开 (vid=${feedInfo.vid}, ${attempt}/${maxAttempts})`);
        return true;
      }
      // vid不匹配，可能点错了视频
      logger.warn(`[VideoProcessor] ⚠ 视频已打开但vid不匹配 (期望=${aid}, 实际=${feedInfo.vid})`);
    } else {
      logger.warn(`[VideoProcessor] ⚠ 第${attempt}次点击后视频未打开 (feedFound=${feedInfo.found})`);
    }

    // === 4. 重试前关闭当前弹窗 ===
    if (attempt < maxAttempts) {
      await human.keyPress(wc, 'Escape');
      if (!await _intSleep(800, 1200, shouldContinue)) return false;
      await human.mouseScroll(wc, 'down', 1);
      if (!await _intSleep(500, 800, shouldContinue)) return false;
    }
  }

  logger.error(`[VideoProcessor] ✗ 连续${maxAttempts}次点击后仍无法打开视频，跳过 ${aid}`);
  return false;
}

/**
 * 等待视频真正加载完成
 * 检测：feed-active-video出现 + recommend-fake-video-img消失
 */
async function waitForVideoReady(view, shouldContinue) {
  const wc = view.webContents;
  const start = Date.now();
  const timeout = 10000;

  while (Date.now() - start < timeout) {
    if (_globalInterrupted || (shouldContinue && !shouldContinue())) return false;
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
    if (!await _intSleep(300, 500, shouldContinue)) return false;
  }
  return false;
}

/**
 * 真人式观看视频
 * - 根据评论数决定观看时长（有评论看久一点）
 * - 鼠标在视频区域自然移动
 * - 偶尔模拟暂停/滑动行为
 */
async function watchVideoLikeHuman(view, commentCount, shouldContinue) {
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
    if (_globalInterrupted || (shouldContinue && !shouldContinue())) return;
    // 鼠标在视频区域自然移动
    if (videoRect) {
      const mx = videoRect.x + rand(50, videoRect.w - 50);
      const my = videoRect.y + rand(50, videoRect.h - 50);
      await human.mouseMove(wc, mx, my);
    }
    if (!await _intSleep(800, 2000, shouldContinue)) return;

    // 3%概率模拟鼠标移到视频中心（极低频率，不点击）
    if (Math.random() < 0.03 && videoRect) {
      const cx = videoRect.x + videoRect.w / 2;
      const cy = videoRect.y + videoRect.h / 2;
      await human.mouseMove(wc, cx, cy);
      if (!await _intSleep(200, 400, shouldContinue)) return;
    }

    // ★ 弹窗形式下不滚动！滚动会切换到下一个视频
  }
}

/**
 * 真人式打开评论区
 * 用鼠标点击评论按钮，不用x键
 */
async function openCommentLikeHuman(view, shouldContinue) {
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
  if (!await _intSleep(200, 500, shouldContinue)) return false;
  await human.humanClick(wc, btnPos.x, btnPos.y);
  return true;
}

/**
 * 聚焦评论区（点击评论区内部获取焦点）
 */
async function focusCommentArea(view, shouldContinue) {
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
async function scrollCommentsWithMouseWheel(view, deltaY, shouldContinue) {
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
  if (!await _intSleep(100, 300, shouldContinue)) return;

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

  if (!await _intSleep(800, 1500, shouldContinue)) return;
}

/**
 * 检测"抢首评"标记
 * ⚠️ 关键修复：只在评论图标附近检测，避免被页面其他位置的"抢首评"文字干扰
 */
async function checkFirstComment(wc) {
  try {
    const r = await wc.executeJavaScript(`(function(){
      // 优先定位到当前视频区域，避免被其他视频卡片的文字干扰
      const activeVideo = document.querySelector('[data-e2e="feed-active-video"]');
      const rootScope = activeVideo || document.body;
      
      const iconSelectors = [
        '[data-e2e="feed-comment-icon"]',
        '[data-e2e="comment-icon"]',
        '[class*="comment" i][class*="icon" i]'
      ];
      
      for (const sel of iconSelectors) {
        const icon = rootScope.querySelector(sel);
        if (icon) {
          // 检查图标及其附近元素的文本
          const checkTargets = [icon, icon.parentElement, icon.parentElement ? icon.parentElement.parentElement : null];
          for (const t of checkTargets) {
            if (!t) continue;
            const text = (t.innerText || '').trim();
            if (text.includes('抢首评')) return true;
          }
        }
      }
      
      // 如果有 feed-active-video，在其范围内搜索 comment 相关元素
      if (activeVideo) {
        const commentRelated = activeVideo.querySelector('[class*="comment" i]');
        if (commentRelated && (commentRelated.innerText || '').includes('抢首评')) {
          return true;
        }
      }
      
      return false;
    })()`);
    return r === true;
  } catch (_) {
    return false;
  }
}

// ===== 新增：页面状态检测函数 =====

async function detectPageState(wc) {
  try {
    return await wc.executeJavaScript(`(function(){
      const url = location.href;
      // ★ 抖音搜索页点击视频后，视频以全屏弹窗形式在当前页面内打开
      // feed-active-video 存在且有video子元素 = 视频已打开（无论URL是否变化）
      const feedEl = document.querySelector('[data-e2e="feed-active-video"]');
      let hasOpenVideo = false;
      if (feedEl) {
        const r = feedEl.getBoundingClientRect();
        const hasVideo = !!feedEl.querySelector('video');
        // 必须有实际尺寸且有video标签
        hasOpenVideo = r.width > 100 && r.height > 100 && hasVideo;
      }
      const isVideoUrl = url.includes('/video/');
      const isSearchUrl = url.includes('/search/') || url.includes('/jingxuan/search/') || url.includes('keyword=');

      // ★ 视频详情页：有可见的feed-active-video播放器（弹窗形式或独立页面）
      if (hasOpenVideo) return 'video_detail';
      // ★ URL是视频页（可能正在加载）
      if (isVideoUrl) return 'video_detail';
      // ★ 搜索结果页
      if (isSearchUrl) return 'search_result';
      if (url === 'https://www.douyin.com/' || url === 'https://douyin.com/') return 'home';
      return 'unknown';
    })()`) || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

/**
 * 增强版退出验证：多方式尝试退出，直到页面状态变为非video_detail
 */
async function ensureExitVideo(wc, view, withComment, shouldContinue) {
  logger.info(`[VideoProcessor] 确保退出视频 (评论区: ${withComment ? '已打开' : '未打开'})...`);
  
  // 先确保关闭评论区
  if (withComment) {
    let closed = false;
    for (let attempt = 0; attempt < 3 && !closed; attempt++) {
      try {
        const isOpen = await wc.executeJavaScript(`(function(){
          const el = document.querySelector('#videoSideCard');
          return el ? el.clientWidth > 0 : false;
        })()`).catch(() => false);
        if (!isOpen) { closed = true; break; }
        if (attempt === 0) await human.keyPress(wc, 'x');
        else if (attempt === 1) {
          const vp = await wc.executeJavaScript(`({ w: window.innerWidth, h: window.innerHeight })`).catch(() => ({ w: 800, h: 600 }));
          await human.mouseMove(wc, Math.round(vp.w * 0.2), Math.round(vp.h * 0.5));
          await human.humanClick(wc, Math.round(vp.w * 0.2), Math.round(vp.h * 0.5));
        } else {
          await wc.executeJavaScript(`(function(){
            const closeButtons = document.querySelectorAll('#videoSideCard [aria-label*="close"], #videoSideCard [data-e2e*="close"], #videoSideCard button');
            for (const btn of closeButtons) {
              const text = (btn.innerText || '').trim();
              if (!text || text.length <= 2) { btn.click(); return true; }
            }
            return false;
          })()`).catch(() => false);
        }
        if (!await _intSleep(800, 1500, shouldContinue)) break;
      } catch (_) {}
    }
  }

  // 模拟浏览视频 2-6s
  await human.mouseMove(wc, rand(200, 600), rand(200, 500));
  if (!await _intSleep(2000, 6000, shouldContinue)) return;

  // 多方式尝试退出
  let exitSuccess = false;
  for (let attempt = 0; attempt < 3 && !exitSuccess; attempt++) {
    if (_globalInterrupted || (shouldContinue && !shouldContinue())) break;
    try {
      if (attempt === 0) await human.keyPress(wc, 'Escape');
      else if (attempt === 1) { await human.mouseMove(wc, 50, 50); await human.humanClick(wc, 50, 50); }
      else await wc.executeJavaScript('history.length > 1 ? history.back() : null').catch(() => {});
      if (!await _intSleep(1500, 3000, shouldContinue)) break;
      const state = await detectPageState(wc);
      if (state === 'search_result' || state === 'home' || state === 'unknown') {
        exitSuccess = true;
        logger.info(`[VideoProcessor] ✓ 视频退出成功 (方式${attempt + 1}, 状态: ${state})`);
      }
    } catch (_) {}
  }
  if (!exitSuccess) logger.warn('[VideoProcessor] ⚠ 视频退出: 3次尝试后仍在视频页，继续流程');
}

/**
 * 真人式关闭评论区 + 退出（兼容旧调用）
 */
async function closeCommentAndExit(wc, view, shouldContinue) { await ensureExitVideo(wc, view, true, shouldContinue); }

/**
 * 真人式退出视频（0评论/未打开评论区时，兼容旧调用）
 */
async function exitVideoLikeHuman(wc, view, shouldContinue) { await ensureExitVideo(wc, view, false, shouldContinue); }

// ========== 工具 ==========

/**
 * 可中断等待（响应暂停/停止）
 * 通过检查 search 模块的状态来实现暂停/停止响应
 */
async function wait(min, max) {
  const total = max ? rand(min, max) : min;
  const step = 500;
  for (let t = 0; t < total; t += step) {
    try {
      const search = require('./search');
      // 停止检查
      if (!search.isRunning()) {
        logger.info('[VideoProcessor] wait: 搜索已停止，中断等待');
        return false;
      }
      // 暂停检查
      if (search.isPaused()) {
        logger.info('[VideoProcessor] wait: 搜索已暂停，等待恢复...');
        while (search.isPaused()) {
          await sleepRaw(500);
          if (!search.isRunning()) {
            logger.info('[VideoProcessor] wait: 暂停期间搜索已停止');
            return false;
          }
        }
        logger.info('[VideoProcessor] wait: 搜索已恢复');
      }
    } catch(_) {}
    await sleepRaw(step);
  }
  return true;
}

/**
 * 基础 sleep（不检查暂停/停止，被 wait 函数使用）
 */
function sleepRaw(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 可中断 sleep（响应暂停/停止）
 * 用于需要支持暂停/停止的短等待 - 同时检查 search / recommend 状态
 */
function sleep(a, b) {
  const ms = b ? rand(a, b) : a;
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const elapsed = Date.now() - start;
      if (elapsed >= ms) return resolve();
      try {
        const search = require('./search');
        const recommend = require('./recommend');
        // 任何一方未运行 -> 中断
        if (_globalInterrupted) return resolve();  // ⚠️ 立即响应中断标志
        const searchStopped = !search.isRunning();
        const recommendStopped = !recommend.isRunning();
        if (searchStopped || recommendStopped) {
          logger.info('[VideoProcessor] sleep: 所有任务已停止，中断等待');
          return resolve();
        }
        // 任何一方暂停 -> 等待恢复
        if (search.isPaused() || recommend.isPaused()) {
          logger.info('[VideoProcessor] sleep: 任务已暂停，等待恢复...');
          const resumeCheck = setInterval(() => {
            try {
              if (_globalInterrupted) { clearInterval(resumeCheck); return resolve(); }
              const s = require('./search');
              const r = require('./recommend');
              if (!s.isRunning() && !r.isRunning()) {
                clearInterval(resumeCheck);
                return resolve();
              }
              if (!s.isPaused() && !r.isPaused()) {
                clearInterval(resumeCheck);
                logger.info('[VideoProcessor] sleep: 任务已恢复');
                check();
              }
            } catch(_) { clearInterval(resumeCheck); resolve(); }
          }, 500);
          return;
        }
      } catch(_) {}
      setTimeout(check, Math.min(300, ms - elapsed));
    };
    setTimeout(check, Math.min(300, ms));
  });
}

module.exports = { processVideo, setInterruptFlag, _isInterrupted };
