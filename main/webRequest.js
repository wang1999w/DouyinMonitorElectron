/**
 * 请求拦截核心模块
 * 使用 Electron session.webRequest API 拦截抖音 API 请求
 * 同时拦截 bytedance:// 等外部协议请求
 */

const { URL } = require('url');

/** 抖音 API 请求过滤规则 */
const FILTER_URLS = [
  '*://*.douyin.com/*api*',
  '*://*.douyin.com/*aweme*',
  '*://*.douyin.com/*comment*',
  '*://*.douyin.com/*search*',
  '*://*.douyin.com/*recommend*'
];

/** 需要拦截的外部协议 */
const BLOCKED_PROTOCOLS = ['bytedance', 'sslocal', 'snssdk', 'aweme'];

/** 静态资源扩展名，用于过滤 */
const STATIC_EXT = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|ttf|eot)(\?|$)/i;

/**
 * 设置请求拦截
 * @param {BrowserView} douyinView - 抖音 BrowserView
 * @param {BrowserWindow} mainWindow - 主窗口
 */
function setupWebRequest(douyinView, mainWindow) {
  if (!douyinView || !mainWindow) return;

  const ses = douyinView.webContents.session;

  // 拦截所有请求，阻止外部协议（bytedance:// 等）
  ses.webRequest.onBeforeRequest(
    { urls: ['*://*/*'] },
    (details, callback) => {
      const url = details.url.toLowerCase();
      const shouldBlock = BLOCKED_PROTOCOLS.some(p => url.startsWith(p + ':'));
      callback({ cancel: shouldBlock });
    }
  );

  // 收集 API 请求数据展示到右栏
  ses.webRequest.onCompleted(
    { urls: FILTER_URLS },
    (details) => {
      if (isStaticResource(details.url)) return;

      const requestInfo = {
        id: Date.now() + Math.random(),
        url: details.url,
        method: details.method,
        statusCode: details.statusCode,
        timestamp: new Date().toLocaleTimeString(),
        type: details.resourceType,
        responseHeaders: details.responseHeaders
      };

      mainWindow.webContents.send('request-data', requestInfo);
    }
  );
}

function isStaticResource(url) {
  return STATIC_EXT.test(url);
}

module.exports = { setupWebRequest };
