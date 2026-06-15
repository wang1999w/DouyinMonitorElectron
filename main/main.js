/**
 * 主进程入口文件
 * 负责：应用生命周期管理、窗口创建、模块初始化
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { createMainWindow, getMainWindow, getDouyinView } = require('./window');
const { setupWebRequest } = require('./webRequest');
const { registerIpcHandlers } = require('./ipc');

let mainWindow = null;

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
  }
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
