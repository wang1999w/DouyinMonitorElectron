/**
 * 窗口管理模块
 * 负责：主窗口创建、BrowserView（抖音页面）管理
 * 使用 BrowserView 而非 iframe，提供更好的性能和隔离性
 */

const { BrowserWindow, BrowserView } = require('electron');
const path = require('path');

let mainWindow = null;
let douyinView = null;

/** 抖音网页 URL */
const DOUYIN_URL = 'https://www.douyin.com';

/**
 * 创建主窗口（右栏 UI 面板）
 * @returns {BrowserWindow} 主窗口实例
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: '抖音监控系统 v2.0',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    douyinView = null;
  });

  createDouyinView();

  return mainWindow;
}

/**
 * 创建 BrowserView（左栏 - 抖音网页）
 * 配置反检测特性，隐藏自动化标志
 */
function createDouyinView() {
  if (!mainWindow) return;

  douyinView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableBlinkFeatures: '',
      disableBlinkFeatures: 'AutomationControlled',
      webSecurity: false
    }
  });

  mainWindow.setBrowserView(douyinView);
  updateDouyinViewBounds();

  douyinView.webContents.loadURL(DOUYIN_URL);

  douyinView.webContents.on('did-finish-load', () => {
    injectAntiDetection(douyinView);
  });

  mainWindow.on('resize', () => {
    updateDouyinViewBounds();
  });
}

/**
 * 更新 BrowserView 的尺寸，适配窗口大小
 * 左栏占 60%，右栏占 40%
 */
function updateDouyinViewBounds() {
  if (!mainWindow || !douyinView) return;

  const { width, height } = mainWindow.getContentBounds();
  const leftWidth = Math.floor(width * 0.6);

  douyinView.setBounds({
    x: 0,
    y: 0,
    width: leftWidth,
    height: height
  });

  mainWindow.webContents.send('resize-panel', {
    leftWidth,
    rightWidth: width - leftWidth,
    height
  });
}

/**
 * 注入反检测脚本到 BrowserView
 * 隐藏 webdriver 标志、伪造 chrome 对象
 * @param {BrowserView} view - 目标 BrowserView
 */
function injectAntiDetection(view) {
  if (!view || !view.webContents) return;

  const script = `
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en']
    });
  `;

  view.webContents.executeJavaScript(script).catch(() => {});
}

/**
 * 获取主窗口实例
 * @returns {BrowserWindow|null}
 */
function getMainWindow() {
  return mainWindow;
}

/**
 * 获取抖音 BrowserView 实例
 * @returns {BrowserView|null}
 */
function getDouyinView() {
  return douyinView;
}

module.exports = {
  createMainWindow,
  getMainWindow,
  getDouyinView,
  updateDouyinViewBounds,
  injectAntiDetection
};
