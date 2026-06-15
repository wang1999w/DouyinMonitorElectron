/**
 * 视频处理流程（重构版 - 基于 laizan 项目学习）
 *
 * 核心改进：
 *   1. 键盘 ArrowDown 导航到下一个视频（不用鼠标点击链接）
 *   2. waitForSelector 替代固定 sleep
 *   3. #videoSideCard 检测评论区
 *   4. 键盘 x 打开评论区 + 评论按钮双保险
 *   5. 验证码用 .second-verify-panel 检测
 *   6. 进度回调驱动，不依赖日志文本
 */

const dom = require('./domUtils');
const human = require('./humanBehavior');
const pipeline = require('./pipeline');
const { getLogger } = require('./logger');

const logger = getLogger('VideoProcessor');

async function processVideo(ctx) {
  const { view, aid, keywords, cdp, shouldContinue, onProgress, onResult, cutoffTs = 0 } = ctx;
  const wc = view.webContents;
  const videoInfo = ctx.videoInfo || { aweme_id: aid, desc: '', author: '', video_url: `https://www.douyin.com/video/${aid}` };
  const result = { matched: 0, cdp: 0, dom: 0, effective: 0, skipped: '' };

  const report = (info) => { if (onProgress) try { onProgress(info); } catch (_) {} };
  const check = () => shouldContinue ? shouldContinue() : true;

  try {
    // 步骤1：点击视频卡片（从搜索结果列表打开）
    report({ phase: 'click', awemeId: aid });
    const clicked = await dom.clickVideoById(view, aid);
    if (!clicked) {
      result.skipped = 'video_not_found';
      log('    视频未找到');
      report({ phase: 'skip', awemeId: aid, reason: '视频未找到' });
      return result;
    }

    // 步骤2：等待视频加载
    report({ phase: 'load', awemeId: aid });
    await sleep(5000, 8000);
    if (!check()) return result;

    // 步骤3：模拟观看
    report({ phase: 'watch', awemeId: aid });
    await human.mouseMove(wc, rand(300, 700), rand(200, 400));
    await sleep(3000, 5000);
    report({ phase: 'checkComment', awemeId: aid });
    const commentCount = await dom.getCommentCount(view);
    if (commentCount === 0) {
      result.skipped = 'no_comments';
      log('    无评论（抢首评），跳过');
      report({ phase: 'skip', awemeId: aid, reason: '无评论' });
      return result;
    }
    log(`    评论数: ${commentCount === -1 ? '未知' : commentCount}`);

    // 步骤4：打开评论区（laizan 方式：x 键 + 检查 #videoSideCard）
    report({ phase: 'openComment', awemeId: aid });
    await human.keyPress(wc, 'x');
    await sleep(3000, 5000);

    // 检查评论区是否打开
    let commentOpen = await dom.isCommentOpen(view);
    if (!commentOpen) {
      log('    评论区未打开，再按一次 x');
      await human.keyPress(wc, 'x');
      await sleep(3000, 5000);
      commentOpen = await dom.isCommentOpen(view);
    }

    if (!commentOpen) {
      // 尝试点击评论按钮
      const commentBtn = await execJS(wc, `(function(){
        const el = document.querySelector('[data-e2e="feed-active-video"] [data-e2e="feed-comment-icon"]');
        if (el) { const r = el.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; }
        return null;
      })()`);
      if (commentBtn) {
        await human.mouseClick(wc, commentBtn.x, commentBtn.y);
        await sleep(2000, 3000);
        commentOpen = await dom.isCommentOpen(view);
      }
    }

    if (!commentOpen) {
      result.skipped = 'comment_panel_missing';
      log('    评论区未出现');
      report({ phase: 'skip', awemeId: aid, reason: '评论区未出现' });
      return result;
    }

    if (!check()) return result;

    // 步骤5：滚动加载评论
    report({ phase: 'scroll', awemeId: aid });
    await dom.scrollCommentPanel(view, 12, 150);
    if (!check()) return result;

    // 步骤6：采集评论
    report({ phase: 'collect', awemeId: aid });
    if (cdp) cdp.beginCollect(aid);
    const cdpComments = cdp ? cdp.getComments(aid) : [];
    const domComments = await dom.readDomComments(view);
    const domOnly = domComments.filter(d => !cdpComments.some(c => c.text === d.text));
    let allComments = [...cdpComments, ...domOnly];

    // 补充视频信息
    if (cdp?.currentVideo?.aweme_id === aid) {
      videoInfo.desc = videoInfo.desc || cdp.currentVideo.desc || '';
      videoInfo.author = videoInfo.author || cdp.currentVideo.author || '';
    }

    // 时效过滤
    if (cutoffTs > 0) {
      const before = allComments.length;
      allComments = allComments.filter(c => (c.create_time || 0) >= cutoffTs);
      if (before > allComments.length) log(`    时效过滤: 排除${before - allComments.length}条`);
    }

    result.cdp = cdpComments.length;
    result.dom = domComments.length;
    result.effective = allComments.length;

    // 步骤7：匹配入库
    report({ phase: 'match', awemeId: aid, cdpCount: result.cdp, domCount: result.dom });
    for (const c of allComments) {
      if (!check()) break;
      const r = pipeline.processComment(c, null, videoInfo, keywords);
      if (r) {
        result.matched++;
        if (onResult) onResult(r);
      }
    }

    // 步骤8：退出视频（laizan 方式：先关评论区，再 ESC）
    if (cdp) cdp.endCollect(aid);
    if (commentOpen) {
      await human.keyPress(wc, 'x');
      await sleep(500, 1000);
    }
    await human.keyPress(wc, 'Escape');
    await sleep(1500, 2500);

    report({ phase: 'done', awemeId: aid, cdpCount: result.cdp, domCount: result.dom, matchCount: result.matched });
    return result;
  } catch (e) {
    result.skipped = 'exception';
    if (cdp) try { cdp.endCollect(aid); } catch (_) {}
    try { await human.keyPress(wc, 'Escape'); } catch (_) {}
    report({ phase: 'error', awemeId: aid, error: e.message });
    log(`    异常: ${e.message}`);
    return result;
  }
}

async function execJS(wc, script) {
  try { return await wc.executeJavaScript(script); } catch (_) { return null; }
}

function log(msg) { logger.info(msg); }

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { processVideo };
