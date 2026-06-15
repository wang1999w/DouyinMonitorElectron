/**
 * 视频处理流程
 * 统一 search.js 与 monitor.js 中"进入视频 → 等待加载 → 模拟观看 →
 * 打开评论区 → 滚动加载 → 采集 CDP+DOM 评论 → 匹配入库" 的整套流程
 *
 * 设计原则：
 *   - 进度通过回调上报（不再依赖日志文本正则解析）
 *   - 中断检查贯穿全过程（checkRunning）
 *   - CDP 状态由 cdpInterceptor 自身负责清理
 *   - 异常路径统一回 ESC
 */

const dom = require('./domUtils');
const human = require('./humanBehavior');
const pipeline = require('./pipeline');
const { getLogger } = require('./logger');

const logger = getLogger('VideoProcessor');

/**
 * 进度回调
 * @typedef {Object} ProgressInfo
 * @property {string} phase - 'click' | 'load' | 'watch' | 'openComment' | 'scroll' | 'collect' | 'match' | 'done' | 'error'
 * @property {number} [count] - 当前视频序号（从1开始）
 * @property {number} [total] - 视频总数
 * @property {number} [cdpCount] CDP 拦截到的评论数
 * @property {number} [domCount] DOM 兜底采集评论数
 * @property {number} [matchCount] 命中条数
 * @property {string} [error] 错误信息
 */

/**
 * 打开评论面板（含重试 + 兜底）
 */
async function openCommentPanel(wc) {
  await human.keyPress(wc, 'x');
  await sleep(4000, 6000);
  if (await dom.hasCommentPanel({ webContents: wc })) return true;

  // 重试一次
  await human.keyPress(wc, 'x');
  await sleep(3000, 5000);
  return await dom.hasCommentPanel({ webContents: wc });
}

/**
 * 处理一个视频的完整流程
 * @param {Object} ctx
 * @param {BrowserView} ctx.view
 * @param {string} ctx.aid 视频 aweme_id
 * @param {Object} ctx.videoInfo 视频元数据（可选，会被 CDP 补充）
 * @param {Object} ctx.keywords { intent, garbage }
 * @param {CDPInterceptor} [ctx.cdp]
 * @param {Function} ctx.shouldContinue 返回 false 立即退出
 * @param {Function} [ctx.onProgress] 进度回调 (info) => void
 * @param {Function} [ctx.onResult] 命中结果回调
 * @param {number} [ctx.cutoffTs] 时效过滤时间戳（秒）
 * @returns {Promise<{matched:number, cdp:number, dom:number, effective:number, skipped:string}>}
 */
async function processVideo(ctx) {
  const { view, aid, keywords, cdp, shouldContinue, onProgress, onResult, cutoffTs = 0 } = ctx;
  const wc = view.webContents;
  const videoInfo = ctx.videoInfo || { aweme_id: aid, desc: '', author: '', video_url: `https://www.douyin.com/video/${aid}` };
  const result = { matched: 0, cdp: 0, dom: 0, effective: 0, skipped: '' };

  const report = (info) => { if (onProgress) try { onProgress(info); } catch (_) {} };

  const ensureContinue = async () => {
    if (!shouldContinue || shouldContinue()) return true;
    return false;
  };

  try {
    // 1. 点击视频
    report({ phase: 'click', awemeId: aid });
    if (!(await ensureContinue())) return result;
    const clicked = await dom.clickVideoById(view, aid);
    if (!clicked) {
      result.skipped = 'video_not_found';
      report({ phase: 'error', awemeId: aid, error: '视频未找到' });
      return result;
    }

    // 2. 等待视频加载
    report({ phase: 'load', awemeId: aid });
    await sleep(5000, 8000);
    if (!(await ensureContinue())) return result;

    // 3. 模拟观看
    report({ phase: 'watch', awemeId: aid });
    await human.mouseMove(wc, rand(300, 700), rand(200, 400));
    await sleep(3000, 5000);

    // 4. 检查评论数：抢首评 = 无评论
    const commentCount = await dom.getCommentCount(view);
    if (commentCount === 0) {
      result.skipped = 'no_comments';
      report({ phase: 'error', awemeId: aid, error: '无评论（抢首评）' });
      await safeEscape(wc);
      return result;
    }

    // 5. 打开评论区
    report({ phase: 'openComment', awemeId: aid, commentCount });
    const opened = await openCommentPanel(wc);
    if (!opened) {
      result.skipped = 'comment_panel_missing';
      report({ phase: 'error', awemeId: aid, error: '评论区未出现' });
      await safeEscape(wc);
      return result;
    }
    if (!(await ensureContinue())) return result;

    // 6. 滚动加载评论
    report({ phase: 'scroll', awemeId: aid });
    await dom.scrollCommentPanel(view, 12, 150);
    if (!(await ensureContinue())) return result;

    // 7. 采集
    report({ phase: 'collect', awemeId: aid });
    // 清理上一次 currentVideo，再采集新的
    if (cdp) cdp.beginCollect(aid);
    const cdpComments = cdp ? cdp.getComments(aid) : [];
    const domComments = await dom.readDomComments(view);
    const domOnly = domComments.filter(d => !cdpComments.some(c => c.text === d.text));
    let allComments = [...cdpComments, ...domOnly];

    // 补充视频信息（CDP 可能在详情接口里补到）
    if (cdp && cdp.currentVideo && cdp.currentVideo.aweme_id === aid) {
      videoInfo.desc = videoInfo.desc || cdp.currentVideo.desc || '';
      videoInfo.author = videoInfo.author || cdp.currentVideo.author || '';
    }

    // 时效过滤
    if (cutoffTs > 0) {
      const before = allComments.length;
      allComments = allComments.filter(c => (c.create_time || 0) >= cutoffTs);
      const filtered = before - allComments.length;
      if (filtered > 0) {
        report({ phase: 'collect', awemeId: aid, filtered });
      }
    }

    result.cdp = cdpComments.length;
    result.dom = domComments.length;
    result.effective = allComments.length;

    // 8. 匹配入库
    report({ phase: 'match', awemeId: aid, cdpCount: result.cdp, domCount: result.dom });
    for (const c of allComments) {
      if (!(await ensureContinue())) break;
      const r = pipeline.processComment(c, null, videoInfo, keywords);
      if (r) {
        result.matched++;
        if (onResult) onResult(r);
      }
    }

    // 9. 退出视频
    if (cdp) cdp.endCollect(aid);
    await safeEscape(wc);

    report({
      phase: 'done',
      awemeId: aid,
      cdpCount: result.cdp,
      domCount: result.dom,
      matchCount: result.matched
    });
    return result;
  } catch (e) {
    result.skipped = 'exception';
    if (cdp) try { cdp.endCollect(aid); } catch (_) {}
    try { await safeEscape(wc); } catch (_) {}
    report({ phase: 'error', awemeId: aid, error: e.message });
    logger.warn(`processVideo 异常: ${e.message}`);
    return result;
  }
}

async function safeEscape(wc) {
  try { await human.keyPress(wc, 'Escape'); } catch (_) {}
  await sleep(1500, 2500);
}

function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

module.exports = { processVideo };
