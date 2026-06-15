/**
 * 视频处理流程（全面修复版）
 *
 * 修复清单：
 *   1. 评论滚动根据数量判断（>9才滚动）
 *   2. 时效过滤不杀 DOM 评论（无时间戳的保留）
 *   3. 暂停/停止在每步检查
 *   4. 重复视频不处理
 */

const dom = require('./domUtils');
const human = require('./humanBehavior');
const pipeline = require('./pipeline');
const { getLogger } = require('./logger');

const logger = getLogger('VideoProcessor');

async function processVideo(ctx) {
  const { view, aid, keywords, cdp, shouldContinue, onResult, onLog, cutoffTs = 0 } = ctx;
  const wc = view.webContents;
  const videoInfo = { aweme_id: aid, desc: '', author: '', video_url: `https://www.douyin.com/video/${aid}` };
  const result = { matched: 0, cdp: 0, dom: 0, effective: 0, skipped: '' };

  const check = () => shouldContinue ? shouldContinue() : true;
  const _log = (msg) => { logger.info(msg); if (onLog) onLog(msg); };

  try {
    // ===== 1. 点击视频 =====
    _log('  1️⃣ 点击视频...');
    const clicked = await dom.clickVideoById(view, aid);
    if (!clicked) { result.skipped = '点击失败'; return result; }

    // ===== 2. 等待加载 =====
    _log('  2️⃣ 等待加载...');
    if (!await wait(5000, 8000)) { result.skipped = '被中断'; return result; }

    // ===== 3. 模拟观看 =====
    _log('  3️⃣ 模拟观看...');
    await human.mouseMove(wc, rand(300, 700), rand(200, 400));
    if (!await wait(3000, 5000)) { result.skipped = '被中断'; return result; }

    // ===== 4. 检查评论数 =====
    _log('  4️⃣ 检查评论...');
    const commentCount = await dom.getCommentCount(view);
    _log(`     评论数: ${commentCount === -1 ? '未知' : commentCount}`);

    if (commentCount === 0) {
      result.skipped = '无评论';
      await closeAndEscape(wc);
      return result;
    }

    // ===== 5. 打开评论区 =====
    _log('  5️⃣ 打开评论区...');
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
      result.skipped = '评论区未打开';
      await closeAndEscape(wc);
      return result;
    }
    _log('     ✓ 已打开');

    // ===== 6. 根据评论数决定滚动策略 =====
    _log('  6️⃣ 滚动加载评论...');
    const commentCountDom = await dom.getCommentCount(view);
    if (commentCountDom > 9) {
      // 评论数 > 9，真实模拟鼠标滚轮滚动
      const scrollTimes = Math.min(Math.ceil(commentCountDom / 5), 15);
      _log(`     评论${commentCountDom}条，滚动${scrollTimes}次`);
      await dom.scrollCommentPanel(view, scrollTimes, 150);
    } else if (commentCountDom === -1) {
      // 评论数未知，尝试滚动几次加载
      _log(`     评论数未知，尝试滚动加载`);
      await dom.scrollCommentPanel(view, 5, 150);
    } else {
      // 评论数 <= 9，不需要滚动
      _log(`     评论${commentCountDom}条，无需滚动`);
    }
    if (!check()) { result.skipped = '被中断'; return result; }

    // ===== 7. 采集评论 =====
    _log('  7️⃣ 采集评论...');
    if (cdp) cdp.beginCollect(aid);
    const cdpComments = cdp ? cdp.getComments(aid) : [];
    const domComments = await dom.readDomComments(view);

    // 从页面提取视频作者信息
    const authorInfo = await wc.executeJavaScript(`
      (function(){
        const info = { author: '', desc: '', profileUrl: '' };
        // 找博主名称（@开头或用户链接旁边的文字）
        const userLinks = document.querySelectorAll('a[href*="/user/"]');
        for (const a of userLinks) {
          const r = a.getBoundingClientRect();
          if (r.width > 5 && r.height > 5) {
            const href = a.getAttribute('href') || '';
            const name = (a.innerText || '').trim().replace(/^@/, '');
            if (name.length > 0 && name.length < 30) {
              info.author = name;
              info.profileUrl = href.startsWith('http') ? href : 'https://www.douyin.com' + href;
              break;
            }
          }
        }
        // 找视频描述
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

    // 补充视频信息
    if (cdp?.currentVideo?.aweme_id === aid) {
      videoInfo.desc = videoInfo.desc || cdp.currentVideo.desc || authorInfo.desc || '';
      videoInfo.author = videoInfo.author || cdp.currentVideo.author || authorInfo.author || '';
    } else {
      videoInfo.desc = videoInfo.desc || authorInfo.desc || '';
      videoInfo.author = videoInfo.author || authorInfo.author || '';
    }
    // 补充博主主页链接
    if (authorInfo.profileUrl && !videoInfo.authorProfile) {
      videoInfo.authorProfile = authorInfo.profileUrl;
    }

    result.cdp = cdpComments.length;
    result.dom = domComments.length;

    // 合并 CDP + DOM 评论（CDP 优先，DOM 补充，去重）
    const allTexts = new Set();
    let allComments = [];
    for (const c of cdpComments) {
      const text = (c.text || '').trim();
      if (!text || allTexts.has(text)) continue;
      allTexts.add(text);
      const ct = c.create_time || 0;
      if (cutoffTs > 0 && ct > 0 && ct < cutoffTs) continue;
      allComments.push(c);
    }
    for (const d of domComments) {
      const text = (d.text || '').trim();
      if (!text || allTexts.has(text)) continue;
      allTexts.add(text);
      allComments.push(d);
    }

    result.effective = allComments.length;
    _log(`     CDP:${cdpComments.length} DOM:${domComments.length} 有效:${allComments.length}`);

    if (allComments.length === 0) {
      result.skipped = '无有效评论';
      if (cdp) cdp.endCollect(aid);
      await closeAndEscape(wc);
      return result;
    }

    // ===== 8. 匹配入库 =====
    _log('  8️⃣ 匹配关键词...');
    let matched = 0;
    for (const c of allComments) {
      if (!check()) break;
      const r = pipeline.processComment(c, null, videoInfo, keywords);
      if (r) {
        matched++;
        if (onResult) onResult(r);
      }
    }
    result.matched = matched;

    // ===== 9. 退出 =====
    if (cdp) cdp.endCollect(aid);
    await closeAndEscape(wc);

    return result;
  } catch (e) {
    result.skipped = `异常: ${e.message}`;
    if (cdp) try { cdp.endCollect(aid); } catch(_) {}
    try { await closeAndEscape(wc); } catch(_) {}
    _log(`  ❌ ${e.message}`);
    return result;
  }
}

// ========== 工具 ==========

async function closeAndEscape(wc) {
  try { await human.keyPress(wc, 'x'); } catch(_) {}
  await sleep(500, 1000);
  try { await human.keyPress(wc, 'Escape'); } catch(_) {}
  await sleep(1500, 2500);
}

async function wait(ms) {
  const step = 500;
  for (let t = 0; t < ms; t += step) {
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
