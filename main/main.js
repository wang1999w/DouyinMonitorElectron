/**
 * 主进程入口文件
 * 负责：应用生命周期管理、窗口创建、模块初始化
 */

const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const { createMainWindow, getMainWindow, getDouyinView } = require('./window');
const { setupWebRequest } = require('./webRequest');
const { registerIpcHandlers } = require('./ipc');

let mainWindow = null;

/** 需要拦截的外部协议（不带冒号） */
const BLOCKED_PROTOCOLS = ['bytedance', 'sslocal', 'snssdk', 'aweme'];

/**
 * 注册自定义协议处理器
 * 必须在 app.ready 之后调用
 */
function registerProtocolHandlers() {
  for (const proto of BLOCKED_PROTOCOLS) {
    protocol.handle(proto, () => {
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
  }
}

function initApp() {
  mainWindow = createMainWindow();
  registerIpcHandlers(mainWindow);

  const douyinView = getDouyinView();
  if (douyinView) {
    setupWebRequest(douyinView, mainWindow);
    setupNavigationGuards(douyinView);
  }
}

function setupNavigationGuards(view) {
  if (!view || !view.webContents) return;

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isBlockedUrl(url)) return { action: 'deny' };
    return { action: 'allow' };
  });

  view.webContents.on('will-navigate', (event, url) => {
    if (isBlockedUrl(url)) event.preventDefault();
  });

  view.webContents.on('did-create-window', (window, details) => {
    if (isBlockedUrl(details.url)) window.close();
  });
}

function isBlockedUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return BLOCKED_PROTOCOLS.some(p => lower.startsWith(p + ':'));
}

app.whenReady().then(() => {
  registerProtocolHandlers();
  initApp();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) initApp();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
