/**
 * 人类行为模拟模块
 * 使用 Electron 原生 API 模拟真人操作
 *
 * 鼠标：sendInputEvent（mouseMove/mouseDown/mouseUp/mouseWheel）
 * 键盘：sendInputEvent（keyDown/keyUp）
 * 文字输入：webContents.insertText()（比 char 事件更可靠）
 */

const { getLogger } = require('./logger');
const logger = getLogger('HumanBehavior');

let lastX = 960;
let lastY = 540;

async function mouseMove(wc, tx, ty) {
  const sx = lastX;
  const sy = lastY;
  const dist = Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2);

  if (dist < 5) {
    await safeSend(wc, { type: 'mouseMove', x: Math.round(tx), y: Math.round(ty) });
    return;
  }

  const steps = Math.max(10, Math.min(40, Math.floor(dist / 25)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const te = t * t * (3 - 2 * t);
    const x = Math.round(te * tx + (1 - te) * sx + (Math.random() - 0.5) * 6);
    const y = Math.round(te * ty + (1 - te) * sy + (Math.random() - 0.5) * 6);
    await safeSend(wc, { type: 'mouseMove', x, y });
    await sleep(rand(3, 12));
  }

  lastX = Math.round(tx);
  lastY = Math.round(ty);
}

async function mouseClick(wc, x, y) {
  await mouseMove(wc, x, y);
  await sleep(rand(80, 200));
  await safeSend(wc, { type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await sleep(rand(40, 100));
  await safeSend(wc, { type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await sleep(rand(50, 150));
}

async function mouseHover(wc, x, y, w, h, duration) {
  await mouseMove(wc, x, y);
  const end = Date.now() + (duration || 2000);
  while (Date.now() < end) {
    await mouseMove(wc, x + rand(-w * 0.1, w * 0.1), y + rand(-h * 0.1, h * 0.1));
    await sleep(rand(300, 700));
  }
}

async function mouseScroll(wc, direction = 'down', times) {
  const count = times || rand(3, 6);
  for (let i = 0; i < count; i++) {
    const deltaY = direction === 'up' ? -rand(80, 200) : rand(80, 200);
    await safeSend(wc, { type: 'mouseWheel', x: rand(300, 700), y: rand(200, 500), deltaX: 0, deltaY });
    await sleep(rand(100, 300));
  }
}

async function keyPress(wc, key, modifiers) {
  const mods = (modifiers || []).map(m => m.toLowerCase());
  await safeSend(wc, { type: 'keyDown', key, keyCode: key, modifiers: mods });
  await sleep(rand(30, 60));
  await safeSend(wc, { type: 'keyUp', key, keyCode: key, modifiers: mods });
  await sleep(rand(30, 60));
}

/**
 * 文字输入 — 使用 webContents.insertText()
 * 比 sendInputEvent({ type: 'char' }) 更可靠
 */
async function typeText(wc, text) {
  try {
    await wc.insertText(text);
  } catch (e) {
    logger.warn(`insertText 失败: ${e.message}`);
  }
}

async function safeSend(wc, event) {
  try {
    await wc.sendInputEvent(event);
  } catch (e) {
    // 静默忽略
  }
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { mouseMove, mouseClick, mouseHover, mouseScroll, keyPress, typeText };
