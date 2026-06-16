/**
 * 预加载脚本（安全通信桥梁）
 * 使用 contextBridge 安全暴露 IPC 通道给渲染进程
 * 渲染进程通过 window.electronAPI 调用主进程功能
 */

const { contextBridge, ipcRenderer } = require('electron');

const SAFE_EVENTS = [
  'request-data', 'search-log', 'search-result', 'search-progress',
  'monitor-log', 'monitor-result', 'monitor-progress',
  'recommend-log', 'recommend-result', 'recommend-progress',
  'stats-updated', 'config-updated', 'wechat-sent', 'resize-panel',
  'error-notify', 'database-error', 'scheduler-log'
];

const SAFE_INVOKES = [
  'start-search', 'stop-search', 'pause-search',
  'start-monitor', 'stop-monitor',
  'start-recommend', 'stop-recommend', 'pause-recommend',
  'get-config', 'save-config',
  'add-blogger', 'update-blogger', 'del-blogger',
  'export-results', 'send-test-email', 'send-test-wechat',
  'get-stats', 'get-matches-page', 'clear-matches',
  'show-douyin-view', 'hide-douyin-view',
  'switch-platform'
];

const api = {};

SAFE_EVENTS.forEach((evt) => {
  const camel = 'on' + evt.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('');
  api[camel] = (cb) => ipcRenderer.on(evt, (_, data) => cb(data));
});

SAFE_INVOKES.forEach((name) => {
  const camel = name.split('-').map((s, i) => i === 0 ? s : s[0].toUpperCase() + s.slice(1)).join('');
  api[camel] = (...args) => ipcRenderer.invoke(name, ...args);
});

contextBridge.exposeInMainWorld('electronAPI', api);
