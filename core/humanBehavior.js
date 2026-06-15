/**
 * 人类行为模拟模块
 * 贝塞尔曲线鼠标移动 + 随机延迟 + 滚动模拟
 * 目标：所有操作完全模拟真人，降低风控检测风险
 */

const { getLogger } = require('./logger');
const logger = getLogger('HumanBehavior');

let lastX = 960;
let lastY = 540;

/**
 * 贝塞尔曲线鼠标移动
 * 模拟真人鼠标轨迹：加速→减速→微调
 * @param {WebContents} wc - BrowserView 的 webContents
 * @param {number} tx - 目标 X
 * @param {number} ty - 目标 Y
 */
async function mouseMove(wc, tx, ty) {
  const sx = lastX;
  const sy = lastY;
  const dist = Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2);

  if (dist < 5) {
    await wc.sendInputEvent({ type: 'mouseMove', x: tx + rand(-1, 1), y: ty + rand(-1, 1) });
    return;
  }

  // 控制点（贝塞尔曲线）
  const cp1x = rand(Math.min(sx, tx), Math.max(sx, tx));
  const cp1y = rand(Math.min(sy, ty) - 40, Math.max(sy, ty) + 40);
  const cp2x = rand(Math.min(sx, tx), Math.max(sx, tx));
  const cp2y = rand(Math.min(sy, ty) - 40, Math.max(sy, ty) + 40);

  const steps = Math.max(15, Math.min(50, Math.floor(dist / rand(15, 30))));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Ease-in-out 缓动
    const te = t * t * (3 - 2 * t);
    const x = cubicBezier(te, sx, cp1x, cp2x, tx) + rand(-3, 3);
    const y = cubicBezier(te, sy, cp1y, cp2y, ty) + rand(-3, 3);

    await wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    await sleep(rand(2, 12));
  }

  lastX = tx + rand(-2, 2);
  lastY = ty + rand(-2, 2);
  await wc.sendInputEvent({ type: 'mouseMove', x: Math.round(lastX), y: Math.round(lastY) });
}

/**
 * 模拟鼠标点击
 * 完整流程：移动 → 悬停 → 按下 → 等待 → 释放
 */
async function mouseClick(wc, x, y) {
  await mouseMove(wc, x, y);
  await sleep(rand(80, 250));
  await wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await sleep(rand(40, 120));
  await wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await sleep(rand(50, 150));
}

/**
 * 模拟鼠标悬停浏览（在元素附近随机移动）
 */
async function mouseHover(wc, x, y, w, h, duration) {
  await mouseMove(wc, x, y);
  const end = Date.now() + (duration || rand(1500, 3000));

  while (Date.now() < end) {
    const dx = rand(-w * 0.15, w * 0.15);
    const dy = rand(-h * 0.15, h * 0.15);
    await mouseMove(wc, x + dx, y + dy);
    await sleep(rand(300, 800));
    if (Math.random() < 0.3) {
      await mouseMove(wc, x + rand(-5, 5), y + rand(-5, 5));
      await sleep(rand(200, 500));
    }
  }
}

/**
 * 模拟鼠标滚动（带随机波动）
 * @param {WebContents} wc
 * @param {string} direction - 'down' 或 'up'
 * @param {number} times - 滚动次数
 */
async function mouseScroll(wc, direction = 'down', times) {
  const count = times || rand(3, 8);

  for (let i = 0; i < count; i++) {
    const amount = rand(80, 250) * (direction === 'up' ? -1 : 1);
    const steps = rand(2, 5);
    const per = amount / steps;

    for (let s = 0; s < steps; s++) {
      await wc.sendInputEvent({ type: 'mouseWheel', x: rand(300, 700), y: rand(200, 500), deltaY: Math.round(per + rand(-3, 3)) });
      await sleep(rand(10, 40));
    }

    await sleep(rand(100, 300));

    // 随机停顿（模拟阅读）
    if (Math.random() < 0.08) {
      await sleep(rand(500, 1500));
    }
  }
}

/**
 * 模拟键盘按键
 */
async function keyPress(wc, key, modifiers) {
  const mods = modifiers || [];
  await wc.sendInputEvent({ type: 'keyDown', key, keyCode: key, modifiers: mods });
  await sleep(rand(30, 80));
  await wc.sendInputEvent({ type: 'keyUp', key, keyCode: key, modifiers: mods });
  await sleep(rand(30, 80));
}

/**
 * 模拟键盘输入文字（逐字输入，带随机延迟）
 */
async function typeText(wc, text) {
  for (const ch of text) {
    await wc.sendInputEvent({ type: 'char', char: ch });
    await sleep(rand(50, 150));
  }
}

/**
 * 模拟人类滚动浏览（在元素区域内）
 */
async function humanScrollBrowse(wc, x, y, w, h) {
  await mouseMove(wc, x, y);
  await sleep(rand(1000, 2500));

  const scrollCount = rand(2, 4);
  for (let i = 0; i < scrollCount; i++) {
    const scrollAmount = rand(100, 300);
    await wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaY: scrollAmount });
    await sleep(rand(300, 800));
  }
}

// ========== 工具函数 ==========

function cubicBezier(t, p0, p1, p2, p3) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  mouseMove, mouseClick, mouseHover, mouseScroll,
  keyPress, typeText, humanScrollBrowse
};
