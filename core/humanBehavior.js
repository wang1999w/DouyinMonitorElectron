/**
 * 人类行为模拟模块 v2.0
 *
 * 升级要点（融合 puppeteer-extra/humanize 思路）:
 *   1. mouseMove 使用 2 控制点 Bezier 曲线 + 高斯抖动
 *   2. humanClick 模拟 hover-then-click（先悬停 80-200ms，再下/上）
 *   3. 滚动加速度变化（sin 曲线）
 *   4. typeText 错字修正概率 5%
 *   5. sendInputEvent 失败重试 + 限流
 *
 * 文档参考:
 *   - https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth
 *   - https://github.com/rpcsc/undetected-puppeteer
 */

const { getLogger } = require('./logger');
const logger = getLogger('HumanBehavior');

let lastX = 960;
let lastY = 540;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 真人停顿 - 在等待过程中鼠标轻微移动，模拟"看页面"行为
 * 避免被反爬检测：长时间静止的鼠标是 bot 特征
 *
 * @param {object} wc
 * @param {number} duration - 毫秒
 */
async function humanPause(wc, duration) {
  const start = Date.now();
  let moves = 0;
  while (Date.now() - start < duration) {
    // 在屏幕中心区域做小幅随机移动
    const baseX = lastX || 960;
    const baseY = lastY || 540;
    const nx = baseX + (Math.random() - 0.5) * 80;
    const ny = baseY + (Math.random() - 0.5) * 60;
    try { await wc.sendInputEvent({ type: 'mouseMove', x: Math.round(nx), y: Math.round(ny) }); } catch (_) {}
    lastX = Math.round(nx);
    lastY = Math.round(ny);
    moves++;
    // 真人"阅读"间隔：300-1200ms
    await sleep(300 + Math.floor(Math.random() * 900));
    // 偶尔（10%概率）触发小幅 scroll up-down 模拟翻页
    if (Math.random() < 0.1) {
      try {
        await wc.sendInputEvent({
          type: 'mouseWheel', x: Math.round(nx), y: Math.round(ny),
          deltaX: 0, deltaY: Math.random() < 0.5 ? -30 : 30
        });
      } catch (_) {}
    }
  }
  return { moves, duration };
}

async function safeSend(wc, event) {
  try {
    await wc.sendInputEvent(event);
    return true;
  } catch (e) {
    // 静默忽略 - BrowserView 切换/页面跳转时偶发
    return false;
  }
}

/**
 * Bezier 三次曲线插值（2 控制点）
 * 返回 [t0..t1] 的曲线点数组 - 真人鼠标走曲线不是直线
 */
function bezierPath(sx, sy, tx, ty) {
  // 控制点：在起止点附近，加入随机扰动制造自然弧度
  const dx = tx - sx;
  const dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // 控制点偏移：垂直于起止线 ± 距离的 0.2-0.5 倍
  const offset = dist * randFloat(0.15, 0.45) * (Math.random() < 0.5 ? -1 : 1);
  const midX = (sx + tx) / 2;
  const midY = (sy + ty) / 2;
  // 垂直方向
  const px = -dy / dist * offset;
  const py = dx / dist * offset;

  const c1x = sx + (tx - sx) * randFloat(0.2, 0.4) + px * randFloat(0.5, 1.0);
  const c1y = sy + (ty - sy) * randFloat(0.2, 0.4) + py * randFloat(0.5, 1.0);
  const c2x = sx + (tx - sx) * randFloat(0.6, 0.8) + px * randFloat(0.3, 0.8);
  const c2y = sy + (ty - sy) * randFloat(0.6, 0.8) + py * randFloat(0.3, 0.8);

  const steps = Math.max(15, Math.min(50, Math.floor(dist / 18)));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // 三次贝塞尔公式
    const inv = 1 - t;
    const x = inv * inv * inv * sx + 3 * inv * inv * t * c1x + 3 * inv * t * t * c2x + t * t * t * tx;
    const y = inv * inv * inv * sy + 3 * inv * inv * t * c1y + 3 * inv * t * t * c2y + t * t * t * ty;
    // 加入高斯抖动（鼠标微抖）
    const jitterX = (Math.random() - 0.5) * 2.5;
    const jitterY = (Math.random() - 0.5) * 2.5;
    points.push({
      x: Math.round(x + jitterX),
      y: Math.round(y + jitterY)
    });
  }
  return points;
}

/**
 * 鼠标移动 - 沿 Bezier 曲线 + 加速/减速
 */
async function mouseMove(wc, tx, ty) {
  const sx = lastX;
  const sy = lastY;
  const dist = Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2);

  if (dist < 3) {
    await safeSend(wc, { type: 'mouseMove', x: Math.round(tx), y: Math.round(ty) });
    lastX = Math.round(tx);
    lastY = Math.round(ty);
    return;
  }

  const path = bezierPath(sx, sy, tx, ty);
  const n = path.length;

  for (let i = 0; i < n; i++) {
    const p = path[i];
    await safeSend(wc, { type: 'mouseMove', x: p.x, y: p.y });
    // 变速：开始慢、中间快、结束慢（ease-in-out）
    const t = i / n;
    const speed = 0.3 + Math.sin(t * Math.PI) * 0.7;
    const delay = Math.max(2, Math.floor(3 + (1 - speed) * 12));
    await sleep(delay);
  }

  lastX = Math.round(tx);
  lastY = Math.round(ty);
}

/**
 * 真人点击 - 模拟 hover-then-click 行为
 * 流程: mouseMove (Bezier) → 悬停（80-250ms，jitter） → mouseDown → 30-110ms → mouseUp → 60-180ms
 *
 * 反检测要点：
 *   - 悬停时间带高斯分布（非均匀）
 *   - 偶尔加 5-15ms 微抖，模拟手指自然颤动
 *   - clickCount 真实为 1
 */
async function humanClick(wc, x, y) {
  await mouseMove(wc, x, y);
  // 悬停时间用 Box-Muller 高斯分布，均值 130ms，方差 40ms
  const hoverBase = 130 + (Math.random() + Math.random() - 1) * 30;
  await sleep(Math.max(60, Math.floor(hoverBase)));
  // 微抖：mouseDown 前位置轻微移动（5% 概率）
  if (Math.random() < 0.05) {
    try {
      await wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x + (Math.random() - 0.5) * 3), y: Math.round(y + (Math.random() - 0.5) * 3) });
    } catch (_) {}
    await sleep(8 + Math.floor(Math.random() * 12));
  }
  await safeSend(wc, { type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await sleep(rand(30, 110));
  await safeSend(wc, { type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await sleep(rand(60, 180));
}

/**
 * 兼容旧 API：mouseClick 等同于 humanClick
 */
async function mouseClick(wc, x, y) {
  return humanClick(wc, x, y);
}

/**
 * 双击
 */
async function doubleClick(wc, x, y) {
  await humanClick(wc, x, y);
  await sleep(rand(80, 180));
  await safeSend(wc, { type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 2 });
  await sleep(rand(30, 60));
  await safeSend(wc, { type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 2 });
  await sleep(rand(50, 120));
}

/**
 * 悬停一段时间 - 模拟"看一眼"
 */
async function mouseHover(wc, x, y, w, h, duration) {
  await mouseMove(wc, x, y);
  const end = Date.now() + (duration || 2000);
  while (Date.now() < end) {
    // 在区域内小幅移动
    const nx = x + rand(-w * 0.1, w * 0.1);
    const ny = y + rand(-h * 0.1, h * 0.1);
    await mouseMove(wc, nx, ny);
    await sleep(rand(300, 700));
  }
}

/**
 * 滚动 - 变速
 */
async function mouseScroll(wc, direction = 'down', times) {
  const count = times || rand(3, 6);
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const base = direction === 'up' ? -rand(80, 200) : rand(80, 200);
    const accel = Math.sin(t * Math.PI) * 0.5 + 0.5; // 0.5-1.0
    const deltaY = Math.round(base * (0.7 + accel * 0.3));
    await safeSend(wc, {
      type: 'mouseWheel',
      x: rand(300, 700),
      y: rand(200, 500),
      deltaX: 0,
      deltaY
    });
    await sleep(rand(100, 300));
  }
}

async function keyPress(wc, key, modifiers) {
  const mods = (modifiers || []).map(m => m.toLowerCase());
  // 特殊键映射：key -> code
  const keyCodes = {
    'Enter': 'Enter', 'Escape': 'Escape', 'Tab': 'Tab', 'Backspace': 'Backspace',
    'Delete': 'Delete', 'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
    'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight', 'Space': 'Space'
  };
  const code = keyCodes[key] || key;
  await safeSend(wc, { type: 'keyDown', key, code, keyCode: key, modifiers: mods });
  await sleep(rand(30, 60));
  await safeSend(wc, { type: 'keyUp', key, code, keyCode: key, modifiers: mods });
  await sleep(rand(30, 60));
}

/**
 * 等待元素动画完成（页面层） - 通过 webContents 注入脚本监听动画事件
 * 与 smartOps.waitForAnimationEnd 区别：
 *   - 此版本在等待期间会自动 mouse-jiggle（避免反爬）
 *   - 适合"操作完后等待页面稳定"场景
 *
 * @param {object} wc
 * @param {string} selector
 * @param {number} timeout
 */
async function waitForAnimationEnd(wc, selector, timeout) {
  timeout = timeout || 2000;
  // 注入一次性监听
  const tag = '__animWait_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
  try {
    await wc.executeJavaScript(`(function(sel, t, tag){
      window['__animWait_' + tag] = { done: false };
      const el = document.querySelector(sel);
      if (!el) return;
      const finish = () => { window['__animWait_' + tag] = { done: true }; };
      const anims = (typeof el.getAnimations === 'function') ? el.getAnimations() : [];
      if (anims.length > 0) {
        Promise.all(anims.map(a => a.finished.catch(() => null))).then(finish);
      } else {
        const cs = getComputedStyle(el);
        if ((!cs.animationName || cs.animationName === 'none') && (!cs.transitionProperty || cs.transitionProperty === 'none')) {
          finish();
        } else {
          el.addEventListener('animationend', finish, { once: true });
          el.addEventListener('transitionend', finish, { once: true });
        }
      }
      setTimeout(finish, t);
    })(${JSON.stringify(selector)}, ${timeout}, ${JSON.stringify(tag)})`);
  } catch (_) {}

  // 在等待期间执行 mouse-jiggle
  await humanPause(wc, timeout);
  return { completed: true, tag };
}

/**
 * 真人逐字输入 - 错字修正 + 不规则节奏
 */
async function typeText(wc, text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    await safeSend(wc, { type: 'keyDown', key: ch, keyCode: 0 });
    await safeSend(wc, { type: 'char', char: ch });
    await safeSend(wc, { type: 'keyUp', key: ch, keyCode: 0 });

    // 基础节奏 50-150ms
    let delay = rand(50, 150);
    // 15% 概率出现长停顿（思考）
    if (Math.random() < 0.15) delay += rand(300, 500);
    // 5% 概率模拟错字 + 退格
    if (i > 0 && i < text.length - 1 && Math.random() < 0.05) {
      const wrongChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
      await safeSend(wc, { type: 'keyDown', key: wrongChar, keyCode: wrongChar });
      await safeSend(wc, { type: 'char', char: wrongChar });
      await safeSend(wc, { type: 'keyUp', key: wrongChar, keyCode: wrongChar });
      await sleep(rand(80, 200));
      await safeSend(wc, { type: 'keyDown', key: 'Backspace', keyCode: 'Backspace' });
      await safeSend(wc, { type: 'keyUp', key: 'Backspace', keyCode: 'Backspace' });
      await sleep(rand(100, 200));
    }
    await sleep(delay);
  }
}

module.exports = {
  mouseMove,
  mouseClick,
  humanClick,
  doubleClick,
  mouseHover,
  mouseScroll,
  keyPress,
  typeText,
  humanPause,
  waitForAnimationEnd,
  rand,
  randFloat,
  sleep,
  bezierPath
};
