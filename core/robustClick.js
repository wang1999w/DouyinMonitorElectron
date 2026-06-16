/**
 * 稳健点击定位器 v2.0 - SeleniumBase "best match" 风格
 *
 * 核心设计原则（来自 SeleniumBase）:
 *   1. 多策略链式匹配：data-e2e > role+text > exact text > contains text
 *   2. 模糊匹配必须有上下文约束（容器/y范围/类型）
 *   3. 失败时输出完整诊断（候选元素列表 + 拒绝原因）
 *   4. 不猜——失败就上报，调用者决定下一步
 *
 * 修复 v1.0 的问题：
 *   - sizeRange 限制太严格（实际"视频"tab 可能 > 100px 宽）
 *   - role 限定太严（抖音 tab 不一定带 role="tab"）
 *   - 多策略未做优先级排序，导致合理候选被排除
 */

const { getLogger } = require('./logger');
const logger = getLogger('RobustClick');

/**
 * 评分式查找 - 返回最佳匹配（SeleniumBase best_match 思想）
 * @param {object} view - Electron BrowserView
 * @param {object} query - {text, role, dataE2E, parent, yMin, yMax, xMin, xMax, ...}
 * @returns {Promise<{matches: [...], best: {...}|null, reason: string}>}
 */
async function findBest(view, query) {
  const wc = view.webContents;
  const q = JSON.stringify({
    text: query.text || '',
    role: query.role || '',
    dataE2E: query.dataE2E || '',
    parent: query.parent || '',
    yMin: query.yMin ?? -99999,
    yMax: query.yMax ?? 99999,
    xMin: query.xMin ?? -99999,
    xMax: query.xMax ?? 99999,
    wMin: query.wMin ?? 0,
    wMax: query.wMax ?? 99999,
    hMin: query.hMin ?? 0,
    hMax: query.hMax ?? 99999,
    textMode: query.textMode || 'exact',  // 'exact' | 'startsWith' | 'includes'
    onlyLeaf: query.onlyLeaf !== false
  });

  const script = `(function(){
    const q = ${q};
    const root = q.parent ? document.querySelector(q.parent) : document;
    if (!root) return { error: 'parent_not_found', parent: q.parent };

    function rectOf(el) {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    function isVisible(r) {
      return r.w > q.wMin && r.w < q.wMax && r.h > q.hMin && r.h < q.hMax
          && r.x > q.xMin && r.x < q.xMax && r.y > q.yMin && r.y < q.yMax
          && r.w > 0 && r.h > 0;
    }
    function score(el) {
      let s = 100;
      // 优先级：data-e2e 完全匹配 +100
      if (q.dataE2E && el.getAttribute('data-e2e') === q.dataE2E) s += 200;
      // role 匹配 +50
      if (q.role && el.getAttribute('role') === q.role) s += 50;
      // role 包含（tab/button 等） +20
      if (q.role && (el.getAttribute('role') || '').includes(q.role)) s += 20;
      // 文本完全匹配 +50
      const t = (el.innerText || el.textContent || '').trim();
      if (q.text && t === q.text) s += 50;
      // aria-label 匹配 +30
      if (q.text && (el.getAttribute('aria-label') || '').trim() === q.text) s += 30;
      // 面积小的优先（更像按钮）+10
      const a = rectOf(el);
      s -= Math.max(0, Math.min(50, a.w * a.h / 200));
      return s;
    }

    const all = root.querySelectorAll('*');
    const matches = [];
    for (const el of all) {
      if (q.onlyLeaf && el.children.length > 0) continue;
      const r = rectOf(el);
      if (!isVisible(r)) continue;
      const t = (el.innerText || el.textContent || '').trim();

      // 文本过滤
      if (q.text) {
        if (q.textMode === 'exact' && t !== q.text) continue;
        if (q.textMode === 'startsWith' && !t.startsWith(q.text)) continue;
        if (q.textMode === 'includes' && !t.includes(q.text)) continue;
      }
      // data-e2e 过滤
      if (q.dataE2E && el.getAttribute('data-e2e') !== q.dataE2E) continue;
      // role 过滤
      if (q.role) {
        const r = el.getAttribute('role') || '';
        if (r !== q.role) continue;
      }

      matches.push({
        tag: el.tagName.toLowerCase(),
        text: t.substring(0, 50),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) },
        center: { x: Math.round(r.x + r.w/2), y: Math.round(r.y + r.h/2) },
        dataE2E: el.getAttribute('data-e2e') || '',
        role: el.getAttribute('role') || '',
        ariaLabel: (el.getAttribute('aria-label') || '').substring(0, 40),
        className: (el.className || '').toString().substring(0, 60),
        score: score(el)
      });
    }

    matches.sort((a, b) => b.score - a.score);
    return { count: matches.length, best: matches[0] || null, top5: matches.slice(0, 5) };
  })()`;

  try {
    const r = await wc.executeJavaScript(script);
    if (r && r.error) return { matches: [], best: null, reason: r.error };
    if (!r || r.count === 0) {
      return { matches: [], best: null, reason: 'no_match', query };
    }
    return { matches: r.top5, best: r.best, reason: 'ok' };
  } catch (e) {
    return { matches: [], best: null, reason: 'js_error: ' + e.message };
  }
}

/**
 * 点击顶部 tab (综合/视频/用户/直播)
 * 抖音搜索结果页 tab 实际结构（来自实际项目 log 分析）:
 *   - y ~ 60-80px
 *   - x 在搜索栏下方
 *   - text 内容
 *   - 无固定 data-e2e，需用 text 匹配
 */
async function clickTopTab(view, tabName) {
  // 1. 尝试 data-e2e 已知映射（实测可能没有，但先尝试）
  const e2eMap = {
    '综合': 'search-card-tab-综合',
    '视频': 'search-card-tab-视频',
    '用户': 'search-card-tab-用户',
    '直播': 'search-card-tab-直播'
  };
  const e2eTry = await findBest(view, { dataE2E: e2eMap[tabName], yMax: 200 });
  if (e2eTry.best) {
    return await _doClick(view, e2eTry.best, 'data-e2e');
  }

  // 2. 文本 + 顶部区域（宽松：y < 150）
  const textResult = await findBest(view, {
    text: tabName,
    textMode: 'exact',
    yMin: 30,
    yMax: 150,
    wMax: 200,
    hMax: 60
  });

  if (textResult.best && textResult.matches.length === 1) {
    return await _doClick(view, textResult.best, 'text_unique');
  }

  if (textResult.best) {
    // 多个匹配 → 选 score 最高的（带 data-e2e 优先）
    return await _doClick(view, textResult.best, 'text_best_of_many');
  }

  // 3. 退化：找最近文本 - tabName 的 a 标签
  const linkResult = await findBest(view, {
    text: tabName,
    textMode: 'exact',
    yMin: 30,
    yMax: 200,
    parent: '[class*="tab" i], [class*="Tab"], [role="tablist"]'
  });
  if (linkResult.best) {
    return await _doClick(view, linkResult.best, 'in_tablist');
  }

  // 失败：返回详细诊断
  const dump = await require('./pageInspector').dumpClickableElements(view);
  return {
    success: false,
    error: 'tab_not_found',
    target: tabName,
    diagnostics: {
      tried: ['data-e2e', 'text_top', 'text_in_tablist'],
      candidates: textResult.matches,
      allClickable: dump.items ? dump.items.filter(i => i.y < 200).slice(0, 20) : []
    }
  };
}

/**
 * 点击筛选面板里的选项
 * 先找到面板容器，再在容器内找选项文本
 */
async function clickFilterOption(view, optionText) {
  // 1. 检测已展开的筛选面板（多种 class 模式）
  const panelSelectors = [
    '[class*="filter" i]',
    '[class*="Filter"]',
    '[class*="sift" i]',
    '[class*="dialog" i]',
    '[role="dialog"]',
    '[class*="popover" i]',
    '[class*="drawer" i]',
    '[class*="panel" i]'
  ];

  for (const sel of panelSelectors) {
    const panelInfo = await findBest(view, {
      parent: sel,
      yMax: 800,
      wMin: 100,
      hMin: 100
    });
    if (!panelInfo.best) continue;

    // 在容器内找选项
    const opt = await findBest(view, {
      text: optionText,
      textMode: 'exact',
      parent: sel,
      yMin: 0,
      yMax: 9999,
      wMax: 200,
      hMax: 60
    });

    if (opt.best) {
      return await _doClick(view, opt.best, 'in_panel[' + sel + ']');
    }
  }

  // 2. 退化：全局文本 + 不在顶部 tab 区
  const fallback = await findBest(view, {
    text: optionText,
    textMode: 'exact',
    yMin: 200,           // 排除顶部 tab
    yMax: 800,
    wMax: 200,
    hMax: 60
  });
  if (fallback.best && fallback.matches.length === 1) {
    return await _doClick(view, fallback.best, 'fallback_global');
  }
  if (fallback.best) {
    return await _doClick(view, fallback.best, 'fallback_global_best');
  }

  return { success: false, error: 'option_not_found', target: optionText, candidates: fallback.matches };
}

/**
 * 通用点击 - 给定精确坐标
 * 增强：增加 waitForClickable 三态预检 + 失败自动重试
 */
async function _doClick(view, best, strategy) {
  const human = require('./humanBehavior');
  const smartOps = require('./smartOps');
  const wc = view.webContents;
  const x = best.center.x;
  const y = best.center.y;

  // 1. 显式等待该坐标处的元素可点击（presence + visible + enabled + not-covered）
  const probe = await smartOps.waitForClickable(view, { selector: best.selector || '' }, 1500).catch(() => null);
  // 三态检测只是兜底，不强制要求通过（页面有动画时可能瞬间 covered）

  // 2. 点击前校验：坐标处不能是 input/textarea（避免误中输入框）
  const danger = await wc.executeJavaScript(`(function(){
    const el = document.elementFromPoint(${x}, ${y});
    if (!el) return { danger: true, reason: 'no_element' };
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return { danger: true, reason: 'over_input', tag };
    return { danger: false, tag, text: (el.innerText||'').trim().substring(0, 30) };
  })()`);

  if (danger && danger.danger) {
    return {
      success: false,
      error: 'click_would_overlay_danger',
      reason: danger.reason,
      x, y, target: best.text
    };
  }

  // 2.5 遮挡检测：若目标位置被 overlay/modal 拦截，尝试关闭
  const overlay = await detectOverlayAt(view, x, y);
  if (overlay.overlay && overlay.dismissable) {
    // 优先 ESC
    try { await human.keyPress(wc, 'Escape'); } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
    // 再检查
    const overlay2 = await detectOverlayAt(view, x, y);
    if (overlay2.overlay) {
      // 仍未关闭 → 尝试点击外部安全区
      const dismissed = await dismissOverlay(view, overlay2);
      if (!dismissed) {
        return {
          success: false,
          error: 'click_overlay_unresolved',
          overlay,
          x, y, target: best.text
        };
      }
    }
  }

  // 3. 等待目标元素动画完成（解决 transform 抖动问题）
  if (best.selector) {
    try { await smartOps.waitForAnimationEnd(wc, best.selector, 1200); } catch (_) {}
  }

  // 4. 真人点击（Bezier 轨迹 + 悬停 + 抖动）
  await human.humanClick(wc, x, y);
  logger.info(`click[${strategy}]: "${best.text}" @(${x},${y}) tag=${best.tag} e2e=${best.dataE2E}`);
  return {
    success: true,
    x, y,
    target: best.text,
    strategy,
    landedOn: { tag: danger.tag, text: danger.text }
  };
}

/**
 * 检测 (x,y) 坐标处的遮挡元素
 */
async function detectOverlayAt(view, x, y) {
  try {
    const wc = view.webContents;
    const r = await wc.executeJavaScript(`(function(){
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return { overlay: false, top: null };
      const tag = el.tagName.toLowerCase();
      const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const ariaModal = (el.getAttribute('aria-modal') || '').toLowerCase();
      const tokens = ['modal', 'backdrop', 'overlay', 'mask', 'popup', 'dialog', 'drawer', 'curtain', 'scrim', 'modal-wrap', 'semi-modal'];
      const isOverlay = tokens.some(t => cls.includes(t)) || role === 'dialog' || ariaModal === 'true';
      const rect = el.getBoundingClientRect();
      return {
        overlay: isOverlay,
        top: tag,
        cls: cls.substring(0, 100),
        role, ariaModal,
        zIndex: getComputedStyle(el).zIndex,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        dismissable: isOverlay && !cls.includes('required') && !cls.includes('forced') && !cls.includes('confirm-required')
      };
    })()`);
    return r || { overlay: false };
  } catch (e) {
    return { overlay: false, error: e.message };
  }
}

/**
 * 尝试关闭检测到的遮挡层
 * 策略：点外部 → ESC → 找关闭按钮
 */
async function dismissOverlay(view, overlay) {
  const human = require('./humanBehavior');
  const wc = view.webContents;

  // 1. 点击 overlay 外部（底部空白区）
  try {
    const safe = await wc.executeJavaScript(`(function(){
      const w = window.innerWidth, h = window.innerHeight;
      // 尝试 overlay 之外的位置
      const tries = [
        { x: w * 0.05, y: h * 0.05 },
        { x: w * 0.95, y: h * 0.95 },
        { x: 5, y: 5 }
      ];
      for (const t of tries) {
        const el = document.elementFromPoint(t.x, t.y);
        if (!el) return t;
        const tag = el.tagName.toLowerCase();
        const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        if ((tag === 'body' || tag === 'html' || !cls.match(/modal|backdrop|overlay|popup|dialog/)) && el !== document.body) {
          return t;
        }
      }
      return { x: 5, y: 5 };
    })()`);
    await human.humanClick(wc, safe.x, safe.y);
    await new Promise(r => setTimeout(r, 250));
  } catch (_) {}

  // 2. ESC
  try { await human.keyPress(wc, 'Escape'); } catch (_) {}
  await new Promise(r => setTimeout(r, 200));

  // 3. 找关闭按钮（class 含 close/×/取消）
  try {
    const closed = await wc.executeJavaScript(`(function(){
      const sels = [
        '[class*="close" i]',
        '[class*="Close"]',
        'button[aria-label*="关闭" i]',
        'button[aria-label*="close" i]',
        '[class*="cancel" i]'
      ];
      for (const s of sels) {
        const els = document.querySelectorAll(s);
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.x < window.innerWidth && r.y < window.innerHeight) {
            el.click();
            return true;
          }
        }
      }
      return false;
    })()`);
    if (closed) await new Promise(r => setTimeout(r, 200));
  } catch (_) {}

  return true;
}

/**
 * HTML5 拖放 - 公开封装（实际实现见 smartOps.html5DragDrop）
 * @param {object} view
 * @param {string} fromSelector
 * @param {string} toSelector
 * @param {object} options
 */
async function html5DragDrop(view, fromSelector, toSelector, options) {
  const smartOps = require('./smartOps');
  return await smartOps.html5DragDrop(view, fromSelector, toSelector, options);
}

/**
 * 强制点击（兜底，覆盖 modal 拦截场景）
 */
async function forceClick(view, query, options) {
  const smartOps = require('./smartOps');
  return await smartOps.forceClick(view, query, options);
}

/**
 * 检测并自动修复遮挡 - 通常在 safeClick 前调用一次
 */
async function ensureNoOverlay(view, targetX, targetY) {
  const overlay = await detectOverlayAt(view, targetX, targetY);
  if (overlay.overlay) {
    logger.warn(`ensureNoOverlay: overlay detected ${overlay.cls || overlay.top}, try dismiss`);
    const ok = await dismissOverlay(view, overlay);
    return { hadOverlay: true, dismissed: ok, overlay };
  }
  return { hadOverlay: false, dismissed: true, overlay: null };
}

/**
 * 高阶安全点击（带自动重试 + 状态校验）
 * 优先用 query（dataE2E/selector/text）而非坐标 - 坐标可能因滚动失效
 *
 * @param {object} view
 * @param {object} query - {dataE2E, selector, text, textMode, x, y}
 * @param {object} options - {timeout, retries, expectedState}
 */
async function safeClick(view, query, options) {
  const smartOps = require('./smartOps');
  return await smartOps.safeClick(view, query, options || {});
}

/**
 * 按文本点击 - 单次重试，不带显式等待
 */
async function clickByText(view, text, textMode) {
  const r = await findBest(view, { text, textMode: textMode || 'exact' });
  if (!r.best) {
    return { success: false, error: 'text_not_found', target: text, candidates: r.matches };
  }
  return await _doClick(view, r.best, 'by_text');
}

/**
 * 按 data-e2e 点击
 */
async function clickByDataE2E(view, dataE2E) {
  const r = await findBest(view, { dataE2E });
  if (!r.best) {
    return { success: false, error: 'e2e_not_found', target: dataE2E, candidates: r.matches };
  }
  return await _doClick(view, r.best, 'by_e2e');
}

/**
 * 关闭弹层 - 用 ESC + 安全区点击
 */
async function closePopover(view) {
  const human = require('./humanBehavior');
  const wc = view.webContents;

  // 1. ESC
  if (typeof human.keyPress === 'function') {
    try { await human.keyPress(wc, 'Escape'); } catch (_) {}
  }
  await new Promise(r => setTimeout(r, 200));

  // 2. 检查是否还有浮层
  const stillOpen = await wc.executeJavaScript(`(function(){
    for (const sel of ['[class*="suggest" i]', '[class*="dropdown" i]', '[class*="popup" i]', '[class*="popover" i]']) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.y < 600) return { open: true, sel };
      }
    }
    return { open: false };
  })()`);

  if (!stillOpen || !stillOpen.open) {
    return { success: true, method: 'escape' };
  }

  // 3. 点击页面底部空白
  const safe = await wc.executeJavaScript(`(function(){
    const w = window.innerWidth, h = window.innerHeight;
    const candidates = [
      { x: w*0.5, y: h*0.9 },
      { x: w*0.3, y: h*0.9 },
      { x: w*0.7, y: h*0.9 }
    ];
    for (const t of candidates) {
      const el = document.elementFromPoint(t.x, t.y);
      if (!el) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') return t;
    }
    return candidates[0];
  })()`);

  await human.mouseClick(wc, safe.x, safe.y);
  await new Promise(r => setTimeout(r, 300));
  return { success: true, method: 'safe_zone', x: safe.x, y: safe.y };
}

/**
 * 一次性 dump 页面结构（用于离线分析）
 */
async function debugDump(view, scenario) {
  return await require('./pageInspector').dumpDouyinStructure(view, scenario);
}

module.exports = {
  findBest,
  clickTopTab,
  clickFilterOption,
  clickByText,
  clickByDataE2E,
  safeClick,
  closePopover,
  debugDump,
  // 抗遮挡
  detectOverlayAt,
  dismissOverlay,
  ensureNoOverlay,
  // 强交互
  forceClick,
  html5DragDrop
};
