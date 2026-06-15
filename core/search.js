/**
 * 搜索引擎模块
 *
 * 完整操作流程（参照原Python版本）：
 *   1. 点击搜索框 → 清空 → 逐字输入关键词 → 点击搜索按钮
 *   2. 等待结果 → 点击"视频"标签
 *   3. 鼠标悬停"筛选"打开面板 → 选择排序 → 选择时间 → 点击筛选关闭
 *   4. 扫描视频 → 逐个点击采集
 *
 * 暂停/停止：每步操作前检查标志，立即响应
 */

const { getDouyinView, getCDPInterceptor } = require('../main/window');
const human = require('./humanBehavior');
const pipeline = require('./pipeline');
const scheduler = require('./scheduler');
const { getLogger } = require('./logger');

const logger = getLogger('SearchEngine');
let searchRunning = false;
let logCallback = null;

function checkRunning() { return searchRunning; }

/**
 * 检测验证码弹窗
 * 抖音验证码特征：包含"验证"文字 + 弹窗遮罩
 */
async function checkCaptcha(wc) {
  try {
    return await wc.executeJavaScript(`
      (function() {
        const text = document.body.innerText;
        // 验证码关键词
        if (text.includes('请完成下列验证') || text.includes('安全验证') || text.includes('人机验证')) return true;
        // 滑块验证
        if (text.includes('按住左边按钮拖动') || text.includes('拖动完成拼图')) return true;
        // 验证码弹窗元素
        if (document.querySelector('[class*="captcha"]') || document.querySelector('[class*="verify"]')) return true;
        return false;
      })()
    `);
  } catch (e) { return false; }
}

/**
 * 等待验证码消失（用户手动处理）
 * 每3秒检查一次，最多等5分钟
 */
async function waitForCaptchaSolved(wc) {
  log('  ⚠️ 检测到验证码！请手动完成验证...');
  notifyUser('检测到验证码，请在左侧页面手动完成验证，完成后会自动继续');

  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    if (!checkRunning()) return false;
    const hasCaptcha = await checkCaptcha(wc);
    if (!hasCaptcha) {
      log('  ✅ 验证码已通过');
      return true;
    }
  }
  log('  验证码等待超时（5分钟）');
  return false;
}

/**
 * 通知用户（通过 IPC 发送到渲染进程）
 */
function notifyUser(msg) {
  log(`  🔔 ${msg}`);
  try {
    const { getMainWindow } = require('../main/window');
    const win = getMainWindow();
    if (win && win.webContents) {
      win.webContents.send('search-log', `🔔 ${msg}`);
    }
  } catch (e) {}
}

/**
 * 搜索前检查是否需要登录
 */
async function ensureLogin(wc) {
  const body = await wc.executeJavaScript('document.body.innerText.substring(0, 300)').catch(() => '');
  if (body.includes('登录') && body.length < 100) {
    log('请在浏览器中登录抖音...');
    for (let i = 0; i < 120; i++) {
      await sleep(3000);
      if (!checkRunning()) return false;
      const b = await wc.executeJavaScript('document.body.innerText.substring(0, 300)').catch(() => '');
      if (!b.includes('登录') || b.length > 100) { log('登录成功'); return true; }
    }
    log('登录超时'); return false;
  }
  return true;
}

async function startSearch(params, onLog, onResult) {
  if (searchRunning) return;
  searchRunning = true;
  logCallback = onLog;
  scheduler.registerSearch(params);

  const isQuantityMode = params.sortEnabled;
  log(`搜索任务启动 [${isQuantityMode ? '数量模式' : '时间模式'}]`);

  try {
    const view = getDouyinView();
    if (!view || !view.webContents) { log('浏览器未就绪'); searchRunning = false; return; }
    const wc = view.webContents;

    // 检查登录
    if (!checkRunning()) return;
    const loginOk = await ensureLogin(wc);
    if (!loginOk) { searchRunning = false; return; }

    // 检查首页验证码
    if (await checkCaptcha(wc)) {
      if (!await waitForCaptchaSolved(wc)) { searchRunning = false; return; }
    }

    const keywords = params.keywords || [];
    const cdp = getCDPInterceptor();
    const cfg = require('./config').loadConfig();
    const intentKw = cfg.search_intent_keywords || [];
    const garbageKw = cfg.search_garbage_keywords || [];
    let totalMatched = 0;

    for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
      if (!checkRunning()) break;

      const kw = keywords[kwIdx];
      log(`[${kwIdx + 1}/${keywords.length}] 搜索关键词: ${kw}`);

      // ===== 步骤1：输入关键词搜索 =====
      if (!checkRunning()) break;
      log('  输入搜索关键词...');
      const searchOk = await typeKeywordAndSearch(view, kw);
      if (!searchOk) { log('  搜索输入失败，跳过'); continue; }
      await sleep(5000, 7000);

      // 搜索后检查验证码
      if (await checkCaptcha(wc)) {
        if (!await waitForCaptchaSolved(wc)) break;
        await sleep(2000, 3000);
      }

      // ===== 步骤2：点击"视频"标签 =====
      if (!checkRunning()) break;
      log('  切换到视频标签...');
      await clickByText(view, '视频');
      await sleep(2000, 3000);

      // ===== 步骤3：执行筛选（仅数量模式） =====
      if (!checkRunning()) break;
      if (isQuantityMode) {
        const hasFilter = params.sortMode !== 'default' || (params.filterTime && params.filterTime !== '0') ||
                          (params.filterDuration && params.filterDuration !== '0');
        if (hasFilter) {
          log('  执行筛选...');
          await applySortFilter(view, params);
          await sleep(2000, 3000);
        }
      }

      // ===== 步骤4：扫描视频 =====
      if (!checkRunning()) break;
      const videos = await scanVideos(view);
      if (videos.length === 0) {
        log('  未发现视频，诊断页面结构...');
        // 诊断：打印所有链接的 href 格式
        const links = await wc.executeJavaScript(`
          (function() {
            const all = document.querySelectorAll('a[href]');
            const hrefs = [];
            for (const a of all) {
              const h = a.getAttribute('href') || '';
              if (h.includes('video') || h.includes('aweme') || h.includes('/v/')) {
                hrefs.push(h.substring(0, 80));
              }
            }
            // 也检查其他可能的视频容器
            const cards = document.querySelectorAll('[class*="video"], [class*="card"], [class*="item"]');
            const bodySnippet = document.body.innerHTML.substring(0, 2000);
            return { hrefs: hrefs.slice(0, 10), cardCount: cards.length, bodySnippet: bodySnippet.substring(0, 500) };
          })()
        `).catch(() => null);
        if (links) {
          log(`  诊断: 视频相关href ${links.hrefs.length}个`);
          links.hrefs.forEach(h => log(`    href: ${h}`));
          log(`  诊断: video/card元素 ${links.cardCount}个`);
        }
        continue;
      }
      log(`  发现 ${videos.length} 个视频`);

      // ===== 步骤5：处理视频 =====
      if (isQuantityMode) {
        const maxVideos = params.maxVideos || 10;
        let count = 0;
        for (let i = 0; i < videos.length && count < maxVideos; i++) {
          if (!checkRunning()) break;
          log(`  [${count + 1}/${maxVideos}] 处理视频 ${videos[i].aid}`);
          const m = await processVideo(view, videos[i].aid, params, intentKw, garbageKw, cdp, onResult);
          totalMatched += m;
          count++;
          // 随机浏览间隔
          for (let w = 0; w < 5; w++) {
            if (!checkRunning()) break;
            await sleep(1000, 3000);
          }
        }
      } else {
        let idx = 0;
        const startTime = Date.now();
        const maxDur = params.taskDuration || 30 * 60 * 1000;
        while (checkRunning()) {
          if (Date.now() - startTime >= maxDur) { log('  任务时间已到'); break; }
          if (idx >= videos.length) {
            log('  滚动加载更多...');
            await human.mouseScroll(wc, 'down', 2);
            await sleep(2000, 3000);
            const more = await scanVideos(view);
            let added = 0;
            for (const v of more) { if (!videos.some(x => x.aid === v.aid)) { videos.push(v); added++; } }
            if (added === 0) { log('  无更多视频'); break; }
          }
          if (!checkRunning()) break;
          log(`  [${idx + 1}] 处理视频 ${videos[idx].aid} (${Math.round((Date.now() - startTime) / 60000)}分钟)`);
          const m = await processVideo(view, videos[idx].aid, params, intentKw, garbageKw, cdp, onResult);
          totalMatched += m;
          idx++;
          log(`  已处理${idx}个, 命中${totalMatched}条`);
          for (let w = 0; w < 5; w++) {
            if (!checkRunning()) break;
            await sleep(1000, 3000);
          }
        }
      }
    }

    log(`搜索完成！共 ${totalMatched} 条意向`);
  } catch (e) {
    log(`搜索异常: ${e.message}`);
  } finally {
    searchRunning = false;
    scheduler.notifySearchDone();
  }
}

/**
 * 模拟搜索操作（参照原Python版本）
 * 点击搜索框 → 检查内容长度 → 逐个Backspace清空 → 逐字输入 → 点击搜索
 * 绝不使用 Ctrl+A，避免全选页面内容
 */
async function typeKeywordAndSearch(view, keyword) {
  const wc = view.webContents;

  // 找到搜索框
  const searchInput = await wc.executeJavaScript(`
    (function() {
      const el = document.querySelector('[data-e2e="searchbar-input"], input[placeholder*="搜索"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2, value: el.value || '', w: r.width };
    })()
  `).catch(() => null);

  if (!searchInput) {
    log('    未找到搜索框');
    return false;
  }

  // 点击搜索框获取焦点
  await human.mouseClick(wc, searchInput.x, searchInput.y);
  await sleep(300, 500);

  // 检查搜索框是否有内容，有则逐个Backspace删除（不用Ctrl+A）
  const contentLen = (searchInput.value || '').length;
  if (contentLen > 0) {
    log(`    清空搜索框 (${contentLen}个字符)...`);
    for (let i = 0; i < contentLen; i++) {
      if (!checkRunning()) return false;
      await human.keyPress(wc, 'Backspace');
      await sleep(30, 80);
    }
    await sleep(200, 400);
  }

  // 逐字输入关键词
  for (const ch of keyword) {
    if (!checkRunning()) return false;
    await human.typeText(wc, ch);
    await sleep(50, 150);
  }
  await sleep(500, 1000);

  // 点击搜索按钮
  const searchBtn = await wc.executeJavaScript(`
    (function() {
      const el = document.querySelector('[data-e2e="searchbar-button"], button[class*="search"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()
  `).catch(() => null);

  if (searchBtn) {
    await human.mouseClick(wc, searchBtn.x, searchBtn.y);
    log('    已点击搜索按钮');
  } else {
    log('    未找到搜索按钮，按回车');
    await human.keyPress(wc, 'Enter');
  }

  return true;
}

/**
 * 筛选操作（参照原Python版本）
 * 鼠标悬停"筛选" → 打开面板 → 选择选项 → 点击"筛选"关闭
 */
async function applySortFilter(view, params) {
  const wc = view.webContents;

  // 找到"筛选"按钮
  const filterPos = await wc.executeJavaScript(`
    (function() {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (t.includes('筛选')) {
          const r = el.getBoundingClientRect();
          if (r.width > 20 && r.width < 120 && r.y > 30 && r.y < 250)
            return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()
  `).catch(() => null);

  if (!filterPos) { log('    未找到筛选按钮'); return; }

  // 鼠标悬停打开筛选面板（不是点击！）
  await human.mouseHover(wc, filterPos.x, filterPos.y, 50, 20, 1500);
  await sleep(1500, 2500);

  // 选择排序方式
  const sortMap = { likes: '最多点赞', newest: '最新发布' };
  if (params.sortMode && sortMap[params.sortMode]) {
    await clickFilterOption(wc, sortMap[params.sortMode]);
    log(`    排序: ${sortMap[params.sortMode]}`);
    await sleep(1000, 2000);
  }

  // 选择发布时间
  const timeMap = { '1': '一天内', '7': '一周内', '180': '半年内' };
  if (params.filterTime && timeMap[params.filterTime]) {
    await clickFilterOption(wc, timeMap[params.filterTime]);
    log(`    时间: ${timeMap[params.filterTime]}`);
    await sleep(1000, 2000);
  }

  // 选择视频时长
  const durationMap = { short: '1分钟以下', mid: '1-5分钟', long: '5分钟以上' };
  if (params.filterDuration && durationMap[params.filterDuration]) {
    await clickFilterOption(wc, durationMap[params.filterDuration]);
    log(`    时长: ${durationMap[params.filterDuration]}`);
    await sleep(1000, 2000);
  }

  // 点击"筛选"按钮关闭面板并应用
  await human.mouseClick(wc, filterPos.x, filterPos.y);
  log('    筛选已应用');
  await sleep(2000, 3000);
}

async function clickFilterOption(wc, text) {
  try {
    const pos = await wc.executeJavaScript(`
      (function() {
        const candidates = document.querySelectorAll('button, span, div, label, a');
        for (const el of candidates) {
          const t = (el.innerText || '').trim();
          if (t !== '${text}') continue;
          const r = el.getBoundingClientRect();
          if (r.width > 5 && r.height > 5 && r.height < 60 && r.width < 200 && r.y > 100) {
            return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()
    `).catch(() => null);
    if (pos) {
      await human.mouseClick(wc, pos.x, pos.y);
    } else {
      log(`    选项"${text}"未找到`);
    }
  } catch (e) {}
}

// ========== 视频处理 ==========

async function processVideo(view, aid, params, intentKw, garbageKw, cdp, onResult) {
  if (!checkRunning()) return 0;
  const wc = view.webContents;

  // 处理前检查验证码
  if (await checkCaptcha(wc)) {
    if (!await waitForCaptchaSolved(wc)) return 0;
  }

  try {
    // 点击视频
    const pos = await wc.executeJavaScript(`
      (function() {
        const links = document.querySelectorAll('a[href*="/video/${aid}"]');
        for (const a of links) {
          a.scrollIntoView({ block: 'center' });
          const r = a.getBoundingClientRect();
          if (r.width > 50 && r.height > 50)
            return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
        return null;
      })()
    `).catch(() => null);
    if (!pos) { log('    视频未找到'); return 0; }

    await sleep(500, 1000);
    await human.mouseClick(wc, pos.x, pos.y);
    await sleep(4000, 6000);

    if (!checkRunning()) return 0;

    // 诊断：点击后检查页面状态
    const afterClick = await wc.executeJavaScript(`
      (function() {
        return {
          url: location.href,
          title: document.title,
          hasVideoPlayer: !!document.querySelector('video, [class*="player"], [class*="Player"]'),
          hasComment: !!document.querySelector('[data-e2e="comment-list"], [class*="comment"]'),
          bodyLen: document.body.innerText.length,
          bodySnippet: document.body.innerText.substring(0, 200)
        };
      })()
    `).catch(() => null);
    if (afterClick) {
      log(`    点击后: URL=${afterClick.url.substring(0, 60)}`);
      log(`    标题: ${afterClick.title}`);
      log(`    视频播放器: ${afterClick.hasVideoPlayer ? '存在' : '不存在'}`);
      log(`    评论区: ${afterClick.hasComment ? '存在' : '不存在'}`);
      log(`    内容长度: ${afterClick.bodyLen}`);
    }

    // 模拟观看
    await human.mouseMove(wc, rand(300, 700), rand(200, 400));
    await sleep(2000, 4000);

    // 打开评论区
    await human.keyPress(wc, 'x');
    await sleep(3000, 4000);

    if (!checkRunning()) return 0;

    // 滚动加载评论
    for (let s = 0; s < 20; s++) {
      if (!checkRunning()) break;
      await human.mouseScroll(wc, 'down', 1);
      if (Math.random() < 0.3) await human.mouseMove(wc, rand(600, 900), rand(300, 600));
      await sleep(1000, 2000);
    }

    // 采集评论
    const videoInfo = { aweme_id: aid, desc: '', author: '', video_url: `https://www.douyin.com/video/${aid}` };
    const cdpComments = cdp ? cdp.getComments(aid) : [];
    const domComments = await readDomComments(view);
    const domOnly = domComments.filter(d => !cdpComments.some(c => c.text === d.text));
    const allComments = [...cdpComments, ...domOnly];

    if (cdp?.currentVideo?.aweme_id === aid) {
      videoInfo.desc = cdp.currentVideo.desc || '';
      videoInfo.author = cdp.currentVideo.author || '';
    }

    let matched = 0;
    for (const c of allComments) {
      if (!checkRunning()) break;
      const result = pipeline.processComment(c, null, videoInfo, { intent: intentKw, garbage: garbageKw });
      if (result) { matched++; if (onResult) onResult(result); }
    }

    log(`    CDP:${cdpComments.length} DOM:${domComments.length} 命中:${matched}`);

    await human.keyPress(wc, 'Escape');
    await sleep(2000, 3000);
    return matched;
  } catch (e) {
    log(`    处理异常: ${e.message}`);
    try { await human.keyPress(wc, 'Escape'); } catch (e2) {}
    return 0;
  }
}

// ========== 工具 ==========

async function clickByText(view, text) {
  try {
    const pos = await view.webContents.executeJavaScript(`
      (function() {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.innerText || '').trim();
          if (t === '${text}') {
            const r = el.getBoundingClientRect();
            if (r.width > 10 && r.height > 10 && r.height < 50 && r.y < 200)
              return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()
    `).catch(() => null);
    if (pos) await human.mouseClick(view.webContents, pos.x, pos.y);
  } catch (e) {}
}

async function scanVideos(view) {
  try {
    return await view.webContents.executeJavaScript(`
      (function() {
        const links = document.querySelectorAll('a[href*="/video/"]');
        const result = [];
        const seen = new Set();
        for (const a of links) {
          const m = (a.getAttribute('href') || '').match(/\\/video\\/(\\d+)/);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          result.push({ aid: m[1] });
        }
        return result;
      })()
    `).catch(() => []);
  } catch (e) { return []; }
}

async function readDomComments(view) {
  try {
    return await view.webContents.executeJavaScript(`
      (function() {
        const result = [];
        const seen = new Set();
        const SKIP = new Set(['回复','分享','作者赞过','收起','展开','举报','复制','删除','赞','踩','抢沙发','添加表情']);
        const items = document.querySelectorAll('[data-e2e="comment-list"] > div > div, [class*="comment-item"], [class*="CommentItem"]');
        for (const item of items) {
          let best = '';
          let nick = '';
          for (const el of item.querySelectorAll('p, span, div')) {
            const t = (el.innerText || '').trim();
            if (!t || t.length < 3 || t.length > 500 || SKIP.has(t)) continue;
            if (/^\\d+$/.test(t) || /^[\\d\\.]+万?$/.test(t)) continue;
            if (t.length > best.length) best = t;
          }
          if (!best || best.length < 4 || seen.has(best)) continue;
          seen.add(best);
          const ne = item.querySelector('a[href*="/user/"]');
          if (ne) { const nt = (ne.innerText || '').trim(); if (nt.length > 0 && nt.length < 30 && !SKIP.has(nt)) nick = nt; }
          result.push({ text: best, nickname: nick, comment_id: 'dom_' + Math.random().toString(36).substr(2, 9) });
        }
        return result;
      })()
    `).catch(() => []);
  } catch (e) { return []; }
}

function stopSearch() {
  searchRunning = false;
  log('搜索已停止');
  try {
    const { getMainWindow } = require('../main/window');
    const win = getMainWindow();
    if (win && win.webContents) win.webContents.send('search-log', '搜索已停止');
  } catch (e) {}
}

function pauseSearch() {
  searchRunning = false;
  log('搜索已暂停');
}

function isRunning() { return searchRunning; }

function log(msg) { logger.info(msg); if (logCallback) logCallback(msg); }
function sleep(min, max) {
  const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(resolve => setTimeout(resolve, ms));
}
function rand(min, max) { return Math.floor(Math.random() * (max - min) + min); }

module.exports = { startSearch, stopSearch, pauseSearch, isRunning };
