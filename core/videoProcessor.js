/**
 * 视频处理流程
 * 每步操作都有日志，评论检测用多种选择器
 */

const dom = require('./domUtils');
const human = require('./humanBehavior');
const pipeline = require('./pipeline');
const { getLogger } = require('./logger');

const logger = getLogger('VideoProcessor');

async function processVideo(ctx) {
  const { view, aid, keywords, cdp, shouldContinue, onResult, cutoffTs = 0 } = ctx;
  const wc = view.webContents;
  const videoInfo = ctx.videoInfo || { aweme_id: aid, desc: '', author: '', video_url: `https://www.douyin.com/video/${aid}` };
  const result = { matched: 0, cdp: 0, dom: 0, effective: 0, skipped: '' };

  const check = () => shouldContinue ? shouldContinue() : true;

  try {
    // 1. 点击视频卡片
    log('  🖱 点击视频...');
    const clicked = await dom.clickVideoById(view, aid);
    if (!clicked) { result.skipped = 'not_found'; log('  ❌ 视频未找到'); return result; }

    // 2. 等待加载
    log('  ⏳ 等待视频加载...');
    if (!await interruptibleSleep(5000, 8000)) return result;

    // 3. 模拟观看
    log('  👁 模拟观看...');
    await human.mouseMove(wc, rand(300, 700), rand(200, 400));
    if (!await interruptibleSleep(3000, 5000)) return result;

    // 4. 检查评论数
    log('  📊 检查评论数...');
    const commentCount = await dom.getCommentCount(view);
    if (commentCount === 0) {
      result.skipped = 'no_comments';
      log('  ⏭ 无评论（抢首评），跳过');
      await closeAndEscape(wc);
      return result;
    }
    log(`  评论数: ${commentCount === -1 ? '未知' : commentCount}`);

    // 5. 打开评论区
    log('  💬 打开评论区...');
    await human.keyPress(wc, 'x');
    if (!await interruptibleSleep(3000, 5000)) return result;

    // 检查评论区（多种选择器）
    let commentOpen = await dom.isCommentOpen(view);
    if (!commentOpen) {
      log('  评论区未打开，再按x...');
      await human.keyPress(wc, 'x');
      if (!await interruptibleSleep(3000, 5000)) return result;
      commentOpen = await dom.isCommentOpen(view);
    }

    if (!commentOpen) {
      // 尝试点击评论按钮
      const btn = await js(wc, `(function(){
        const el=document.querySelector('[data-e2e="feed-active-video"] [data-e2e="feed-comment-icon"],[class*="comment-icon"]');
        if(el){const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};}
        return null;
      })()`);
      if (btn) {
        await human.mouseClick(wc, btn.x, btn.y);
        if (!await interruptibleSleep(2000, 3000)) return result;
        commentOpen = await dom.isCommentOpen(view);
      }
    }

    if (!commentOpen) {
      result.skipped = 'no_comment_panel';
      log('  ❌ 评论区未打开');
      await closeAndEscape(wc);
      return result;
    }
    log('  ✓ 评论区已打开');

    if (!check()) return result;

    // 6. 滚动加载评论
    log('  📜 滚动加载评论...');
    await dom.scrollCommentPanel(view, 12, 150);
    if (!check()) return result;

    // 7. 采集评论
    log('  📥 采集评论...');
    if (cdp) cdp.beginCollect(aid);
    const cdpComments = cdp ? cdp.getComments(aid) : [];
    const domComments = await dom.readDomComments(view);
    const domOnly = domComments.filter(d => !cdpComments.some(c => c.text === d.text));
    let allComments = [...cdpComments, ...domOnly];

    if (cdp?.currentVideo?.aweme_id === aid) {
      videoInfo.desc = videoInfo.desc || cdp.currentVideo.desc || '';
      videoInfo.author = videoInfo.author || cdp.currentVideo.author || '';
    }

    // 时效过滤
    if (cutoffTs > 0) {
      const before = allComments.length;
      allComments = allComments.filter(c => (c.create_time || 0) >= cutoffTs);
      if (before > allComments.length) log(`  时效过滤: 排除${before - allComments.length}条`);
    }

    result.cdp = cdpComments.length;
    result.dom = domComments.length;
    result.effective = allComments.length;
    log(`  CDP:${cdpComments.length} DOM:${domComments.length} 有效:${allComments.length}`);

    // 8. 匹配入库
    let matched = 0;
    for (const c of allComments) {
      if (!check()) break;
      const r = pipeline.processComment(c, null, videoInfo, keywords);
      if (r) { matched++; if (onResult) onResult(r); }
    }
    result.matched = matched;
    log(`  🎯 命中: ${matched}条`);

    // 9. 退出
    if (cdp) cdp.endCollect(aid);
    await closeAndEscape(wc);

    return result;
  } catch (e) {
    result.skipped = 'exception';
    if (cdp) try { cdp.endCollect(aid); } catch(_) {}
    try { await closeAndEscape(wc); } catch(_) {}
    log(`  ❌ 异常: ${e.message}`);
    return result;
  }
}

async function closeAndEscape(wc) {
  try { await human.keyPress(wc, 'x'); await sleep(500, 1000); } catch(_) {}
  try { await human.keyPress(wc, 'Escape'); await sleep(1500, 2500); } catch(_) {}
}

async function interruptibleSleep(ms) {
  const step = 500;
  for (let t = 0; t < ms; t += step) {
    if (!require('./search').isRunning()) return false;
    await sleep(step);
  }
  return true;
}

async function js(wc, s) { try { return await wc.executeJavaScript(s); } catch(_) { return null; } }
function log(msg) { logger.info(msg); }
function sleep(a, b) { const ms = b ? rand(a,b) : a; return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random()*(b-a)+a); }

module.exports = { processVideo };
