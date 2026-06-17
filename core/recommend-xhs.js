/**
 * 小红书推荐页浏览模块
 *
 * 功能：
 *   1. 自动浏览小红书首页推荐
 *   2. 识别笔记标题+描述，匹配关键词
 *   3. 符合关键词的笔记 → 打开详情 → 滚动评论 → 采集时效评论
 *   4. 支持设定任务结束时间
 */

const dom = require('./domUtils-xhs');
const noteProcessor = require('./noteProcessor');
const human = require('./humanBehavior');
const { getLogger } = require('./logger');

const logger = getLogger('XHS-Recommend');

let recommendRunning = false;
let recommendPaused = false;
let logCallback = null;
let currentTask = null;

function isRunning() { return recommendRunning; }
function isPaused() { return recommendPaused; }

function stopRecommend() {
  recommendRunning = false;
  recommendPaused = false;
  if (currentTask) currentTask.stopped = true;
  log('🛑 小红书推荐浏览已停止');
}

function pauseRecommend() {
  if (!recommendRunning) return;
  recommendPaused = !recommendPaused;
  log(recommendPaused ? '⏸ 暂停' : '▶ 继续');
}

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

async function startRecommend(params, onLog, onResult, onProgress, getViewFn, getCdpFn) {
  if (recommendRunning) return;
  recommendRunning = true;
  recommendPaused = false;
  logCallback = onLog;

  const task = { params, processedIds: new Set(), stopped: false, matchedTotal: 0, videoCount: 0, commentCount: 0 };
  currentTask = task;

  const videoKeywords = params.videoKeywords || [];
  // 评论时效（小时）：默认1小时=60分钟，与搜索模块一致
  const commentHours = params.commentHours || 1;
  const cutoffTs = Math.floor(Date.now() / 1000) - commentHours * 3600;
  log(`  评论时效: ${commentHours}小时 (cutoff=${new Date(cutoffTs * 1000).toLocaleString('zh-CN')})`);
  const maxComments = params.maxComments || 200;
  const endTime = params.endTime || 0;

  log(`🚀 启动小红书推荐浏览 关键词: ${videoKeywords.join(', ')}`);

  try {
    const view = getViewFn();
    if (!view || !view.webContents) { log('❌ 浏览器未就绪'); return; }
    const wc = view.webContents;
    const cdp = getCdpFn();

    const cfg = require('./config').loadConfig();
    const intentKw = cfg.xhs_search_intent_keywords || cfg.search_intent_keywords || [];
    const garbageKw = cfg.xhs_search_garbage_keywords || cfg.search_garbage_keywords || [];

    // 导航到小红书首页
    log('导航到小红书首页...');
    await wc.loadURL('https://www.xiaohongshu.com');
    await dom.sleep(3000, 5000);
    // 模拟人类进入首页后的浏览行为
    await human.humanPause(wc, human.rand(2000, 4000));
    await human.mouseScroll(wc, 'down', 2);
    await dom.sleep(1000, 2000);

    let loop = 0;
    while (recommendRunning) {
      if (endTime > 0 && Date.now() >= endTime) {
        log('⏰ 任务结束时间已到');
        break;
      }

      loop++;
      log(`\n━━━ 第${loop}轮浏览 ━━━`);

      // 滚动加载推荐内容
      await human.mouseScroll(wc, 'down', 3);
      await dom.sleep(2000, 3000);

      // 扫描当前页面上的笔记
      const notes = await dom.scanNoteLinks(view);
      const unprocessed = notes.filter(n => !task.processedIds.has(n.noteId));

      if (unprocessed.length === 0) {
        log('未发现新笔记，继续滚动...');
        await dom.sleep(1500, 2500);
        continue;
      }

      for (const note of unprocessed) {
        if (!recommendRunning) break;
        if (endTime > 0 && Date.now() >= endTime) break;

        task.processedIds.add(note.noteId);
        task.videoCount++;

        // 检查笔记标题是否匹配视频关键词
        const title = note.title || '';
        const matchedVideoKw = videoKeywords.filter(kw => title.includes(kw));

        if (matchedVideoKw.length === 0) {
          // 不匹配，跳过
          continue;
        }

        log(`📌 笔记命中: ${title.slice(0, 30)} [${matchedVideoKw.join(',')}]`);

        // 处理笔记（采集评论+匹配意向词）
        const result = await noteProcessor.processNote({
          view, noteId: note.noteId,
          keywords: { intent: intentKw, garbage: garbageKw },
          cdp,
          shouldContinue: () => recommendRunning && !task.stopped,
          onResult: (r) => {
            r.video_keywords = matchedVideoKw;
            task.matchedTotal++;
            if (onResult) onResult(r);
          },
          onLog: log,
          maxComments,
          cutoffTs,
          videoInfo: {
            note_id: note.noteId,
            title: title,
            author: note.author || '',
            author_url: note.authorUrl || '',
            note_url: `https://www.xiaohongshu.com/explore/${note.noteId}`
          }
        });

        task.commentCount += (result.cdp || 0) + (result.dom || 0);

        if (onProgress) {
          onProgress({
            videoCount: task.videoCount,
            cdpTotal: task.commentCount,
            matchedTotal: task.matchedTotal
          });
        }

        // 处理完笔记后，弹窗已在noteProcessor中关闭
        // 模拟人类浏览后停顿，然后继续滚动
        await human.humanPause(wc, human.rand(2000, 5000));
      }

      // 随机暂停
      if (recommendRunning && loop % 3 === 0) {
        const sec = rand(10, 30);
        log(`⏸ 休息 ${sec}s`);
        if (!await wait(sec * 1000)) break;
      }
    }

    log(`✅ 小红书推荐浏览完成！共浏览${task.videoCount}篇笔记，命中${task.matchedTotal}条`);
  } catch (e) {
    log(`❌ 异常: ${e.message}`);
  } finally {
    recommendRunning = false;
    recommendPaused = false;
    currentTask = null;
  }
}

function log(msg) {
  logger.info(msg);
  if (logCallback) logCallback(msg);
}

function sleep(a, b) { const ms = b ? rand(a, b) : a; return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

module.exports = { startRecommend, stopRecommend, pauseRecommend, isRunning, isPaused };
