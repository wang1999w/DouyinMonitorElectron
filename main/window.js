/**
 * 窗口管理模块（重构版）
 *
 * 负责：主窗口创建、BrowserView（抖音页面）管理、CDP 拦截器生命周期
 *
 * 重构要点：
 *   - 显式 cleanupCDP()，在 window 'closed' 与 main.js before-quit 时调用
 *   - reload 时重新注入反检测脚本（页面刷新会丢失 navigator 覆盖）
 *   - did-finish-load 与 did-navigate 之后都做一次注入兜底
 *   - getCDPInterceptor 改为惰性创建 + 安全判空
 */

const { BrowserWindow, BrowserView } = require('electron');
const path = require('path');
const CDPInterceptor = require('../core/cdpInterceptor');
const { getLogger } = require('../core/logger');

const logger = getLogger('Window');

let mainWindow = null;
let douyinView = null;
let cdpInterceptor = null;

const DOUYIN_URL = 'https://www.douyin.com';

const BLOCKED_PROTOCOLS = ['bytedance:', 'sslocal:', 'snssdk:', 'aweme:'];

/**
 * 创建主窗口（右栏 UI 面板）
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isBlockedUrl(url)) {
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    cleanupCDP();
    mainWindow = null;
    douyinView = null;
  });

  mainWindow.on('resize', () => {
    updateDouyinViewBounds();
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
      // 抖音风控依赖 webdriver/automation 特征，需要主动禁用
      enableBlinkFeatures: '',
      disableBlinkFeatures: 'AutomationControlled',
      // 抖音接口需跨域请求 Cookie，放开 webSecurity 以避免 CORS 拦截
      webSecurity: false
    }
  });

  mainWindow.setBrowserView(douyinView);
  updateDouyinViewBounds();

  douyinView.webContents.loadURL(DOUYIN_URL);

  // 首次加载完成
  douyinView.webContents.on('did-finish-load', () => {
    onPageReady(douyinView);
  });

  // SPA 内部导航（pushState/replaceState）后重新注入
  douyinView.webContents.on('did-navigate-in-page', () => {
    injectAntiDetection(douyinView);
    injectNavigationBlocker(douyinView);
  });

  // 普通导航（点击链接）
  douyinView.webContents.on('did-navigate', () => {
    injectAntiDetection(douyinView);
    injectNavigationBlocker(douyinView);
  });

  // 页面崩溃或渲染进程消失时清理 CDP
  douyinView.webContents.on('render-process-gone', (e, details) => {
    logger.error(`BrowserView 渲染进程崩溃: ${details.reason}`);
    cleanupCDP();
  });

  // 关闭 BrowserView 自身
  douyinView.webContents.on('destroyed', () => {
    cleanupCDP();
  });
}

function onPageReady(view) {
  injectAntiDetection(view);
  injectNavigationBlocker(view);
  ensureCDPStarted(view);
}

/**
 * 启动或重启 CDP 拦截器
 */
function ensureCDPStarted(view) {
  try {
    if (!cdpInterceptor) {
      cdpInterceptor = new CDPInterceptor();
    }
    if (!view || !view.webContents) return;
    if (view.webContents.isDestroyed && view.webContents.isDestroyed()) return;
    if (view.webContents.debugger.isAttached()) return;
    cdpInterceptor.start(view.webContents);
  } catch (e) {
    logger.error(`CDP 启动失败: ${e.message}`);
  }
}

/**
 * 清理 CDP 资源（窗口关闭 / 应用退出 / 渲染进程崩溃时调用）
 */
function cleanupCDP() {
  if (!cdpInterceptor) return;
  try {
    const wc = douyinView && douyinView.webContents;
    cdpInterceptor.stop(wc);
  } catch (e) {
    logger.warn(`cleanupCDP 异常: ${e.message}`);
  }
  cdpInterceptor = null;
}

/**
 * 注入导航拦截脚本
 * 拦截 bytedance:// 等协议的 window.open 调用
 */
function injectNavigationBlocker(view) {
  if (!view || !view.webContents) return;
  if (view.webContents.isDestroyed && view.webContents.isDestroyed()) return;
  const script = `
    (function() {
      const origOpen = window.open;
      window.open = function(url, ...args) {
        if (url && (url.startsWith('bytedance:') || url.startsWith('sslocal:') ||
            url.startsWith('snssdk:') || url.startsWith('aweme:'))) {
          return null;
        }
        return origOpen.call(window, url, ...args);
      };
      document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]');
        if (link) {
          const href = link.getAttribute('href') || '';
          if (href.startsWith('bytedance:') || href.startsWith('sslocal:') ||
              href.startsWith('snssdk:') || href.startsWith('aweme:')) {
            e.preventDefault();
            e.stopPropagation();
          }
        }
      }, true);
    })();
  `;
  view.webContents.executeJavaScript(script).catch(() => {});
}

/**
 * 更新 BrowserView 尺寸
 * 左栏 60% / 右栏 40%
 */
function updateDouyinViewBounds() {
  if (!mainWindow || !douyinView) return;
  try {
    const { width, height } = mainWindow.getContentBounds();
    const leftWidth = Math.floor(width * 0.6);
    douyinView.setBounds({
      x: 0, y: 0,
      width: leftWidth, height
    });
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('resize-panel', {
        leftWidth,
        rightWidth: width - leftWidth,
        height
      });
    }
  } catch (e) {}
}

/**
 * 注入反检测脚本
 * 隐藏 webdriver 标志、伪造 chrome 对象
 */
function injectAntiDetection(view) {
  if (!view || !view.webContents) return;
  if (view.webContents.isDestroyed && view.webContents.isDestroyed()) return;
  const script = `
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      if (!window.chrome) window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    } catch (e) {}
  `;
  view.webContents.executeJavaScript(script).catch(() => {});
}

function isBlockedUrl(url) {
  if (!url) return false;
  return BLOCKED_PROTOCOLS.some(p => url.toLowerCase().startsWith(p));
}

function getMainWindow() { return mainWindow; }
function getDouyinView() { return douyinView; }
function getCDPInterceptor() { return cdpInterceptor; }

module.exports = {
  createMainWindow,
  getMainWindow,
  getDouyinView,
  getCDPInterceptor,
  updateDouyinViewBounds,
  injectAntiDetection,
  cleanupCDP
};
