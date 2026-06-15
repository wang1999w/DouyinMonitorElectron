/**
 * 预加载脚本（安全通信桥梁）
 * 使用 contextBridge 安全暴露 IPC 通道给渲染进程
 * 渲染进程通过 window.electronAPI 调用主进程功能
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ========== 主进程 → 渲染进程（事件监听） ==========
  onRequestData: (cb) => ipcRenderer.on('request-data', (_, data) => cb(data)),
  onSearchLog: (cb) => ipcRenderer.on('search-log', (_, msg) => cb(msg)),
  onSearchResult: (cb) => ipcRenderer.on('search-result', (_, r) => cb(r)),
  onMonitorLog: (cb) => ipcRenderer.on('monitor-log', (_, msg) => cb(msg)),
  onMonitorResult: (cb) => ipcRenderer.on('monitor-result', (_, r) => cb(r)),
  onStatsUpdated: (cb) => ipcRenderer.on('stats-updated', (_, s) => cb(s)),
  onConfigUpdated: (cb) => ipcRenderer.on('config-updated', (_, c) => cb(c)),
  onWechatSent: (cb) => ipcRenderer.on('wechat-sent', (_, r) => cb(r)),
  onResizePanel: (cb) => ipcRenderer.on('resize-panel', (_, s) => cb(s)),
  onErrorNotify: (cb) => ipcRenderer.on('error-notify', (_, msg) => cb(msg)),

  // ========== 渲染进程 → 主进程（invoke 调用） ==========
  startSearch: (params) => ipcRenderer.invoke('start-search', params),
  stopSearch: () => ipcRenderer.invoke('stop-search'),
  pauseSearch: () => ipcRenderer.invoke('pause-search'),
  startMonitor: () => ipcRenderer.invoke('start-monitor'),
  stopMonitor: () => ipcRenderer.invoke('stop-monitor'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  addBlogger: (b) => ipcRenderer.invoke('add-blogger', b),
  delBlogger: (id) => ipcRenderer.invoke('del-blogger', id),
  exportResults: () => ipcRenderer.invoke('export-results'),
  sendTestEmail: () => ipcRenderer.invoke('send-test-email'),
  sendTestWechat: () => ipcRenderer.invoke('send-test-wechat'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  showDouyinView: () => ipcRenderer.invoke('show-douyin-view'),
  hideDouyinView: () => ipcRenderer.invoke('hide-douyin-view')
});
