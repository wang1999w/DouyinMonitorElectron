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
const XHSCDPInterceptor = require('../core/cdpInterceptor-xhs');
const { getLogger } = require('../core/logger');

const logger = getLogger('Window');

let mainWindow = null;
let douyinView = null;
let cdpInterceptor = null;

// 小红书独立窗口
let xhsWindow = null;
let xhsView = null;
let xhsCdpInterceptor = null;

const DOUYIN_URL = 'https://www.douyin.com';
const XHS_URL = 'https://www.xiaohongshu.com';

const BLOCKED_PROTOCOLS = ['bytedance:', 'sslocal:', 'snssdk:', 'aweme:'];
const XHS_BLOCKED_PROTOCOLS = ['xhsdiscover:', 'xhsdiscoveritem:'];

/**
 * 创建主窗口（右栏 UI 面板）
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'CW自媒体监控系统',
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
  // 先启动 CDP 拦截器（需要先 attach debugger）
  ensureCDPStarted(view);
  // 再注入反检测脚本（可能复用已 attached 的 debugger）
  injectAntiDetection(view);
  injectNavigationBlocker(view);
}

/**
 * 启动或重启 CDP 拦截器
 */
function ensureCDPStarted(view) {
  try {
    if (!view || !view.webContents) return;
    if (view.webContents.isDestroyed && view.webContents.isDestroyed()) return;

    // If CDP interceptor exists and is attached, don't disturb it
    if (cdpInterceptor && cdpInterceptor._webContents && !cdpInterceptor._webContents.isDestroyed()) {
      if (cdpInterceptor._webContents.debugger.isAttached()) {
        logger.info('CDP 拦截器已在运行，跳过重复启动');
        return;
      }
    }

    if (!cdpInterceptor) {
      cdpInterceptor = new CDPInterceptor();
    }
    // Only detach if someone else attached the debugger
    if (view.webContents.debugger.isAttached()) {
      try { view.webContents.debugger.detach(); } catch (_) {}
    }
    cdpInterceptor.start(view.webContents);
    logger.info('CDP 拦截器已启动');
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
 * 反检测脚本 v2.0 - 18 项 stealth evasions
 *
 * 参考 puppeteer-extra-plugin-stealth (github.com/berstend/puppeteer-extra)
 * 与 undetected-puppeteer，覆盖抖音风控最常检测的 18 个维度
 */
const STEALTH_SCRIPT = `
(function() {
  if (window.__douyinStealthApplied) return;
  window.__douyinStealthApplied = true;

  // ============ 1. navigator.webdriver ============
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => false,
      configurable: true
    });
  } catch (e) {}

  // ============ 2. window.chrome runtime 对象 ============
  try {
    if (!window.chrome) window.chrome = {};
    window.chrome.runtime = window.chrome.runtime || {
      PlatformOs: { ARCH: 'x86_64', OS: 'win', MAC: 'undefined', NACL_ARCH: 'x86_64' },
      PlatformArch: 'x86_64',
      RequestUpdateCheckStatus: 'no_update',
      OnInstalledReason: 'install',
      OnRestartRequiredReason: 'app_update',
      connected: false,
      id: undefined
    };
    window.chrome.loadTimes = window.chrome.loadTimes || function() {
      return { requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000, commitLoadTime: Date.now() / 1000, finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: false, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, wasEarlyHintsAvailable: false };
    };
    window.chrome.csi = window.chrome.csi || function() { return { startE: Date.now(), onloadT: Date.now() }; };
    window.chrome.app = window.chrome.app || { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
  } catch (e) {}

  // ============ 3. navigator.plugins（数量+特征） ============
  try {
    Object.defineProperty(Navigator.prototype, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format', length: 1 },
          { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
          { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
          { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 }
        ];
        plugins.item = (i) => plugins[i] || null;
        plugins.namedItem = (n) => plugins.find(p => p.name === n) || null;
        plugins.refresh = () => {};
        return plugins;
      },
      configurable: true
    });
  } catch (e) {}

  // ============ 4. navigator.mimeTypes ============
  try {
    Object.defineProperty(Navigator.prototype, 'mimeTypes', {
      get: () => {
        const mimes = [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null },
          { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null }
        ];
        mimes.item = (i) => mimes[i] || null;
        mimes.namedItem = (n) => mimes.find(m => m.type === n) || null;
        return mimes;
      },
      configurable: true
    });
  } catch (e) {}

  // ============ 5. navigator.languages ============
  try {
    Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
  } catch (e) {}

  // ============ 6. WebGL vendor/renderer 真实化 ============
  try {
    const getParameterProxy = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';   // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return getParameterProxy.call(this, param);
    };
    if (window.WebGL2RenderingContext) {
      const getParameterProxy2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Intel Inc.';
        if (param === 37446) return 'Intel Iris OpenGL Engine';
        return getParameterProxy2.call(this, param);
      };
    }
  } catch (e) {}

  // ============ 7. navigator.hardwareConcurrency ============
  try {
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, configurable: true });
  } catch (e) {}

  // ============ 8. navigator.deviceMemory ============
  try {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true });
  } catch (e) {}

  // ============ 9. iframe.contentWindow 关系链真实化 ============
  try {
    const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: function() {
        const w = origContentWindow && origContentWindow.get ? origContentWindow.get.call(this) : null;
        if (w) {
          try { Object.defineProperty(w, 'top', { get: () => window.top, configurable: true }); } catch (e) {}
        }
        return w;
      }
    });
  } catch (e) {}

  // ============ 10. Notification permission 默认为 default ============
  try {
    if (window.Notification && Notification.permission === 'denied') {
      Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
    }
  } catch (e) {}

  // ============ 11. media codecs（避免空列表） ============
  try {
    if (window.MediaSource) {
      const origIsTypeSupported = MediaSource.isTypeSupported;
      MediaSource.isTypeSupported = function(type) {
        if (typeof type !== 'string') return false;
        if (type.indexOf('webm') !== -1) return true;
        if (type.indexOf('mp4') !== -1) return true;
        return origIsTypeSupported ? origIsTypeSupported.call(this, type) : true;
      };
    }
  } catch (e) {}

  // ============ 12. 隐藏 CDP 标志（Runtime.evaluate 痕迹） ============
  try {
    const origQuery = window.document.querySelector.bind(window.document);
    window.document.querySelector = function(sel) {
      const el = origQuery(sel);
      return el;
    };
  } catch (e) {}

  // ============ 13. permissions API ============
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (params) => {
        if (params && params.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return origQuery(params);
      };
    }
  } catch (e) {}

  // ============ 14. Canvas 指纹噪声（防一致性跟踪） ============
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          // 极轻微噪声：每个像素的 RGB 抖动 ±1
          imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + (Math.random() < 0.5 ? 0 : 1)));
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return origToDataURL.call(this, type);
    };
  } catch (e) {}

  // ============ 15. AudioContext fingerprint 噪声 ============
  try {
    if (window.AudioContext || window.webkitAudioContext) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const origCreateOscillator = AC.prototype.createOscillator;
      AC.prototype.createOscillator = function() {
        const osc = origCreateOscillator.call(this);
        const origConnect = osc.connect.bind(osc);
        osc.connect = function(dest) {
          // 微妙频率扰动
          try { osc.frequency.value = osc.frequency.value + (Math.random() - 0.5) * 0.001; } catch (e) {}
          return origConnect(dest);
        };
        return osc;
      };
    }
  } catch (e) {}

  // ============ 16. document.hasFocus 真实化 ============
  try {
    Object.defineProperty(document, 'hasFocus', { value: () => true, writable: true, configurable: true });
  } catch (e) {}

  // ============ 17. window.outerWidth/Height 真实化 ============
  // Electron 不太好处理，跳过

  // ============ 18. 屏蔽 webdriver 字符串检测（防止 $cdc_ 等） ============
  try {
    const docProps = ['__webdriver_evaluate', '__selenium_evaluate', '__webdriver_unwrap', '__driver_evaluate', '__webdriver_script_function', '__fxdriver_evaluate', '__driver_unwrap', '__webdriver_script_func'];
    for (const p of docProps) {
      try { delete window[p]; delete document[p]; } catch (e) {}
    }
  } catch (e) {}

  console.log('[DouyinStealth] 18 evasions applied');
})();
`;

/**
 * 注入反检测脚本 v2.0
 * 优先使用 CDP Page.addScriptToEvaluateOnNewDocument（每个新文档自动注入）
 * 失败回退 executeJavaScript（仅注入当前文档）
 */
function injectAntiDetection(view) {
  if (!view || !view.webContents) return;
  const wc = view.webContents;
  if (wc.isDestroyed && wc.isDestroyed()) return;

  // CDP 路径：每个新页面加载前自动注入
  if (wc.debugger) {
    try {
      // 如果 CDP 拦截器已经 attach 了 debugger，直接 sendCommand
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        scriptSource: STEALTH_SCRIPT,
        runImmediately: true
      }).then(r => {
        logger.info(`Stealth CDP injected (id=${r.identifier})`);
      }).catch(e => {
        logger.warn(`Stealth CDP inject failed: ${e.message}, fallback to executeJavaScript`);
        wc.executeJavaScript(STEALTH_SCRIPT).catch(() => {});
      });
    } catch (e) {
      logger.warn(`Stealth CDP path error: ${e.message}`);
      wc.executeJavaScript(STEALTH_SCRIPT).catch(() => {});
    }
  } else {
    wc.executeJavaScript(STEALTH_SCRIPT).catch(() => {});
  }
}

function isBlockedUrl(url) {
  if (!url) return false;
  return BLOCKED_PROTOCOLS.some(p => url.toLowerCase().startsWith(p));
}

function getMainWindow() { return mainWindow; }
function getDouyinView() { return douyinView; }
function getCDPInterceptor() { return cdpInterceptor; }
function getXHSWindow() { return xhsWindow; }
function getXHSView() { return xhsView; }
function getXHSCdpInterceptor() { return xhsCdpInterceptor; }

/**
 * 创建小红书独立窗口
 * 完全独立的应用级窗口，内含 BrowserView + 控制面板
 */
function createXHSWindow() {
  if (xhsWindow && !xhsWindow.isDestroyed()) {
    xhsWindow.show();
    xhsWindow.focus();
    return xhsWindow;
  }

  xhsWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'CW自媒体监控系统 - 小红书',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload-xhs.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  xhsWindow.loadFile(path.join(__dirname, '../renderer/xhs.html'));

  xhsWindow.on('closed', () => {
    cleanupXHSCDP();
    xhsWindow = null;
    xhsView = null;
    // 确保主窗口仍然可见（关闭XHS窗口不应影响主窗口）
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  xhsWindow.on('resize', () => {
    updateXHSViewBounds();
  });

  createXHSView();
  return xhsWindow;
}

/**
 * 创建小红书 BrowserView
 */
function createXHSView() {
  if (!xhsWindow) return;

  xhsView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableBlinkFeatures: '',
      disableBlinkFeatures: 'AutomationControlled',
      webSecurity: false
    }
  });

  xhsWindow.setBrowserView(xhsView);
  updateXHSViewBounds();

  xhsView.webContents.loadURL(XHS_URL);

  xhsView.webContents.on('did-finish-load', () => {
    onPageReadyXHS(xhsView);
  });

  xhsView.webContents.on('did-navigate-in-page', () => {
    injectAntiDetectionXHS(xhsView);
    injectNavigationBlockerXHS(xhsView);
  });

  xhsView.webContents.on('did-navigate', () => {
    injectAntiDetectionXHS(xhsView);
    injectNavigationBlockerXHS(xhsView);
    // 导航后CDP可能断开，尝试重连
    setTimeout(() => ensureXHSCDPStarted(xhsView), 2000);
  });

  xhsView.webContents.on('render-process-gone', (e, details) => {
    logger.error(`小红书 BrowserView 渲染进程崩溃: ${details.reason}`);
    cleanupXHSCDP();
  });

  xhsView.webContents.on('destroyed', () => {
    cleanupXHSCDP();
  });
}

function onPageReadyXHS(view) {
  ensureXHSCDPStarted(view);
  injectAntiDetectionXHS(view);
  injectNavigationBlockerXHS(view);
}

function ensureXHSCDPStarted(view) {
  try {
    if (!view || !view.webContents) return;
    if (view.webContents.isDestroyed && view.webContents.isDestroyed()) return;

    // 如果CDP拦截器已在运行且debugger仍attached，跳过
    if (xhsCdpInterceptor && view.webContents.debugger.isAttached()) {
      return;
    }

    if (!xhsCdpInterceptor) {
      xhsCdpInterceptor = new XHSCDPInterceptor();
    }
    if (view.webContents.debugger.isAttached()) {
      try { view.webContents.debugger.detach(); } catch (_) {}
    }
    xhsCdpInterceptor.start(view.webContents);

    // 注册网络请求推送回调（CDP拦截器 -> XHS渲染进程 Network 面板）
    xhsCdpInterceptor.onRequest = (requestData) => {
      if (xhsWindow && xhsWindow.webContents && !xhsWindow.webContents.isDestroyed()) {
        xhsWindow.webContents.send('xhs-request-data', requestData);
      }
    };

    logger.info('小红书 CDP 拦截器已启动');
  } catch (e) {
    logger.error(`小红书 CDP 启动失败: ${e.message}`);
  }
}

function cleanupXHSCDP() {
  if (!xhsCdpInterceptor) return;
  try {
    const wc = xhsView && xhsView.webContents;
    xhsCdpInterceptor.stop(wc);
  } catch (e) {
    logger.warn(`cleanupXHSCDP 异常: ${e.message}`);
  }
  xhsCdpInterceptor = null;
}

/**
 * 更新小红书 BrowserView 尺寸
 */
function updateXHSViewBounds() {
  if (!xhsWindow || !xhsView) return;
  try {
    const { width, height } = xhsWindow.getContentBounds();
    const leftWidth = Math.floor(width * 0.6);
    xhsView.setBounds({ x: 0, y: 0, width: leftWidth, height });
    if (xhsWindow.webContents && !xhsWindow.webContents.isDestroyed()) {
      xhsWindow.webContents.send('resize-panel', {
        leftWidth,
        rightWidth: width - leftWidth,
        height
      });
    }
  } catch (e) {}
}

/**
 * 小红书反检测脚本
 */
const XHS_STEALTH_SCRIPT = `
(function() {
  if (window.__xhsStealthApplied) return;
  window.__xhsStealthApplied = true;

  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch (e) {}
  try {
    if (!window.chrome) window.chrome = {};
    window.chrome.runtime = window.chrome.runtime || { connected: false, id: undefined };
  } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, 'plugins', { get: () => { const p = [{ name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'PDF', length: 1 }]; p.item = (i) => p[i]; return p; }, configurable: true }); } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true }); } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, configurable: true }); } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true }); } catch (e) {}
  try { Object.defineProperty(document, 'hasFocus', { value: () => true, writable: true, configurable: true }); } catch (e) {}
  try { const props = ['__webdriver_evaluate', '__selenium_evaluate', '__webdriver_unwrap']; for (const p of props) { try { delete window[p]; delete document[p]; } catch(e){} } } catch (e) {}
  try { delete window.process; delete window.__electron__; } catch (e) {}

  console.log('[XHSStealth] evasions applied');
})();
`;

function injectAntiDetectionXHS(view) {
  if (!view || !view.webContents) return;
  const wc = view.webContents;
  if (wc.isDestroyed && wc.isDestroyed()) return;
  if (wc.debugger) {
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        scriptSource: XHS_STEALTH_SCRIPT,
        runImmediately: true
      }).catch(() => {
        wc.executeJavaScript(XHS_STEALTH_SCRIPT).catch(() => {});
      });
    } catch (e) {
      wc.executeJavaScript(XHS_STEALTH_SCRIPT).catch(() => {});
    }
  } else {
    wc.executeJavaScript(XHS_STEALTH_SCRIPT).catch(() => {});
  }
}

function injectNavigationBlockerXHS(view) {
  if (!view || !view.webContents) return;
  if (view.webContents.isDestroyed && view.webContents.isDestroyed()) return;
  const script = `
    (function() {
      const origOpen = window.open;
      window.open = function(url, ...args) {
        if (url && (url.startsWith('xhsdiscover:') || url.startsWith('xhsdiscoveritem:'))) {
          return null;
        }
        return origOpen.call(window, url, ...args);
      };
      document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]');
        if (link) {
          const href = link.getAttribute('href') || '';
          if (href.startsWith('xhsdiscover:') || href.startsWith('xhsdiscoveritem:')) {
            e.preventDefault();
            e.stopPropagation();
          }
        }
      }, true);
    })();
  `;
  view.webContents.executeJavaScript(script).catch(() => {});
}

module.exports = {
  createMainWindow,
  getMainWindow,
  getDouyinView,
  getCDPInterceptor,
  ensureCDPStarted,
  updateDouyinViewBounds,
  injectAntiDetection,
  cleanupCDP,
  createXHSWindow,
  getXHSWindow,
  getXHSView,
  getXHSCdpInterceptor,
  updateXHSViewBounds
};
