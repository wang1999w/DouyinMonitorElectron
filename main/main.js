/**
 * 主进程入口文件
 * 负责：应用生命周期管理、窗口创建、模块初始化、全局异常处理
 */

const { app, BrowserWindow, protocol, dialog } = require('electron');
const path = require('path');
const { createMainWindow, getMainWindow, getDouyinView } = require('./window');
const { setupWebRequest } = require('./webRequest');
const { registerIpcHandlers } = require('./ipc');

let mainWindow = null;
const BLOCKED_PROTOCOLS = ['bytedance', 'sslocal', 'snssdk', 'aweme'];

// ========== 全局异常处理 ==========

/** 未捕获异常：记录日志 → 通知用户 → 尝试恢复 */
process.on('uncaughtException', (err) => {
  const msg = `未捕获异常: ${err.message}\n${err.stack}`;
  console.error(msg);
  notifyRenderer('error-notify', msg);
  // 不退出进程，尝试继续运行
});

/** 未处理的 Promise 拒绝 */
process.on('unhandledRejection', (reason) => {
  const msg = `未处理Promise拒绝: ${reason instanceof Error ? reason.message : String(reason)}`;
  console.error(msg);
  notifyRenderer('error-notify', msg);
});

/**
 * 向渲染进程发送错误通知
 * 如果渲染进程不可用，则弹出系统对话框
 */
function notifyRenderer(channel, message) {
  try {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, message);
    } else {
      dialog.showErrorBox('抖音监控系统 - 异常', message);
    }
  } catch (e) {
    console.error('通知渲染进程失败:', e.message);
  }
}

// ========== 协议拦截 ==========

function registerProtocolHandlers() {
  for (const proto of BLOCKED_PROTOCOLS) {
    try {
      protocol.handle(proto, () => {
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/html' } });
      });
    } catch (e) {
      // 协议可能已注册，忽略
    }
  }
}

// ========== 应用初始化 ==========

function initApp() {
  mainWindow = createMainWindow();
  registerIpcHandlers(mainWindow);

  const douyinView = getDouyinView();
  if (douyinView) {
    setupWebRequest(douyinView, mainWindow);
    setupNavigationGuards(douyinView);
  }

  // 监听渲染进程崩溃
  mainWindow.on('render-process-gone', (event, details) => {
    console.error('渲染进程崩溃:', details.reason);
    notifyRenderer('error-notify', `渲染进程崩溃: ${details.reason}`);
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('页面加载失败:', errorCode, errorDescription);
  });
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

  // BrowserView 崩溃处理
  view.webContents.on('render-process-gone', (event, details) => {
    console.error('抖音页面崩溃:', details.reason);
    notifyRenderer('error-notify', `抖音页面崩溃: ${details.reason}，请重启应用`);
  });

  view.webContents.on('unresponsive', () => {
    console.error('抖音页面无响应');
    notifyRenderer('error-notify', '抖音页面无响应，可能需要重启');
  });
}

function isBlockedUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return BLOCKED_PROTOCOLS.some(p => lower.startsWith(p + ':'));
}

// ========== 启动 ==========

app.whenReady().then(() => {
  registerProtocolHandlers();
  initApp();

  const scheduler = require('../core/scheduler');
  scheduler.init((msg) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('search-log', msg);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) initApp();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
