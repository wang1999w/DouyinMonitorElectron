/**
 * 小红书预加载脚本
 * 安全暴露 IPC 通道给小红书渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

const SAFE_EVENTS = [
  'xhs-search-log', 'xhs-search-result', 'xhs-search-progress',
  'xhs-monitor-log', 'xhs-monitor-result', 'xhs-monitor-progress',
  'xhs-recommend-log', 'xhs-recommend-result', 'xhs-recommend-progress',
  'xhs-request-data', 'xhs-stats-updated', 'resize-panel',
  'error-notify'
];

const SAFE_INVOKES = [
  'xhs-start-search', 'xhs-stop-search', 'xhs-pause-search',
  'xhs-start-monitor', 'xhs-stop-monitor',
  'xhs-start-recommend', 'xhs-stop-recommend', 'xhs-pause-recommend',
  'get-config', 'save-config',
  'xhs-add-blogger', 'xhs-update-blogger', 'xhs-del-blogger',
  'xhs-get-stats', 'xhs-get-matches-page', 'xhs-clear-matches',
  'xhs-export-results',
  'xhs-show-window',
  'xhs-hide-view', 'xhs-show-view'
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

contextBridge.exposeInMainWorld('xhsAPI', api);
