/**
 * 主进程入口文件
 * 负责：应用生命周期管理、窗口创建、模块初始化
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { createMainWindow, getMainWindow, getDouyinView } = require('./window');
const { setupWebRequest } = require('./webRequest');
const { registerIpcHandlers } = require('./ipc');

let mainWindow = null;

/** 需要拦截的外部协议 */
const BLOCKED_PROTOCOLS = ['bytedance:', 'sslocal:', 'snssdk:', 'aweme:'];

/**
 * 初始化应用
 * 按顺序：创建窗口 → 注册IPC → 启动请求拦截
 */
function initApp() {
  mainWindow = createMainWindow();

  registerIpcHandlers(mainWindow);

  const douyinView = getDouyinView();
  if (douyinView) {
    setupWebRequest(douyinView, mainWindow);
    setupNavigationGuards(douyinView);
  }
}

/**
 * 设置导航守卫，拦截 bytedance:// 等外部协议链接
 * @param {BrowserView} view - 抖音 BrowserView
 */
function setupNavigationGuards(view) {
  if (!view || !view.webContents) return;

  // 拦截新窗口打开请求
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isBlockedUrl(url)) {
      return { action: 'deny' };
    }
    // 正常链接在 BrowserView 内打开
    return { action: 'allow' };
  });

  // 拦截 navigation 事件（页面跳转）
  view.webContents.on('will-navigate', (event, url) => {
    if (isBlockedUrl(url)) {
      event.preventDefault();
    }
  });

  // 拦截窗口打开事件
  view.webContents.on('did-create-window', (window, details) => {
    if (isBlockedUrl(details.url)) {
      window.close();
    }
  });
}

/**
 * 判断 URL 是否为被拦截的外部协议
 * @param {string} url - 目标 URL
 * @returns {boolean}
 */
function isBlockedUrl(url) {
  if (!url) return false;
  return BLOCKED_PROTOCOLS.some(p => url.toLowerCase().startsWith(p));
}

app.whenReady().then(() => {
  initApp();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      initApp();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
