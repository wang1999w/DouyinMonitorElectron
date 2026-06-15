/**
 * IPC 通信注册模块
 * 负责：注册所有主进程 ↔ 渲染进程的 IPC 事件处理
 * 使用 ipcMain.handle 处理渲染进程的 invoke 请求
 */

const { ipcMain, dialog, app } = require('electron');
const path = require('path');
const fs = require('fs');

/** 延迟加载 core 模块，避免启动时循环依赖 */
let database = null;
let config = null;
let matchModule = null;
let emailModule = null;
let wechatModule = null;
let notifier = null;
let searchEngine = null;
let monitorEngine = null;

function loadCoreModules() {
  if (!database) {
    database = require('../core/database');
    database.initDatabase();
    config = require('../core/config');
    matchModule = require('../core/match');
    emailModule = require('../core/email');
    wechatModule = require('../core/wechat');
    notifier = require('../core/notifier');
    searchEngine = require('../core/search');
    monitorEngine = require('../core/monitor');
  }
}

/**
 * 注册所有 IPC 处理器
 * @param {BrowserWindow} mainWindow - 主窗口实例
 */
function registerIpcHandlers(mainWindow) {
  // ========== 配置相关 ==========
  ipcMain.handle('get-config', () => {
    loadCoreModules();
    return config.loadConfig();
  });

  ipcMain.handle('save-config', (event, cfg) => {
    loadCoreModules();
    config.saveConfig(cfg);
    notifier.reload(cfg);
    return { success: true };
  });

  // ========== 统计数据 ==========
  ipcMain.handle('get-stats', () => {
    loadCoreModules();
    return database.getStats();
  });

  // ========== 博主管理 ==========
  ipcMain.handle('add-blogger', (event, blogger) => {
    loadCoreModules();
    const cfg = config.loadConfig();
    cfg.monitor_bloggers = cfg.monitor_bloggers || [];
    cfg.monitor_bloggers.push(blogger);
    config.saveConfig(cfg);
    return { success: true };
  });

  ipcMain.handle('del-blogger', (event, index) => {
    loadCoreModules();
    const cfg = config.loadConfig();
    if (cfg.monitor_bloggers && cfg.monitor_bloggers[index]) {
      cfg.monitor_bloggers.splice(index, 1);
      config.saveConfig(cfg);
    }
    return { success: true };
  });

  // ========== 搜索相关 ==========
  ipcMain.handle('start-search', (event, params) => {
    loadCoreModules();
    searchEngine.startSearch(
      params,
      (msg) => mainWindow.webContents.send('search-log', msg),
      (result) => mainWindow.webContents.send('search-result', result)
    );
    return { success: true };
  });

  ipcMain.handle('stop-search', () => {
    loadCoreModules();
    searchEngine.stopSearch();
    return { success: true };
  });

  ipcMain.handle('pause-search', () => {
    loadCoreModules();
    searchEngine.pauseSearch();
    return { success: true };
  });

  // ========== 监控相关 ==========
  ipcMain.handle('start-monitor', () => {
    loadCoreModules();
    monitorEngine.startMonitor(
      (msg) => mainWindow.webContents.send('monitor-log', msg)
    );
    return { success: true };
  });

  ipcMain.handle('stop-monitor', () => {
    loadCoreModules();
    monitorEngine.stopMonitor();
    return { success: true };
  });

  // ========== 导出 ==========
  ipcMain.handle('export-results', async () => {
    loadCoreModules();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出意向评论',
      defaultPath: `意向评论_${new Date().toISOString().slice(0, 10)}.xlsx`,
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
    });

    if (canceled || !filePath) return { success: false };

    try {
      const results = database.getRecentMatches(10000);
      await exportToExcel(results, filePath);
      return { success: true, path: filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 邮件测试 ==========
  ipcMain.handle('send-test-email', async () => {
    loadCoreModules();
    try {
      const cfg = config.loadConfig();
      const result = await emailModule.sendTest(cfg.email);
      return { success: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ========== 企微测试 ==========
  ipcMain.handle('send-test-wechat', async () => {
    loadCoreModules();
    try {
      const cfg = config.loadConfig();
      const result = await wechatModule.sendTest(cfg.wechat);
      return { success: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

/**
 * 导出数据到 Excel 文件
 * @param {Array} data - 意向评论数据
 * @param {string} filePath - 输出文件路径
 */
async function exportToExcel(data, filePath) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('意向评论');

  sheet.columns = [
    { header: '评分', key: 'score', width: 8 },
    { header: '昵称', key: 'nickname', width: 15 },
    { header: '抖音号', key: 'douyin_id', width: 15 },
    { header: '评论内容', key: 'comment_text', width: 40 },
    { header: '命中关键词', key: 'matched_keywords', width: 15 },
    { header: '评论时间', key: 'comment_time', width: 18 },
    { header: 'IP属地', key: 'ip_label', width: 10 },
    { header: '所属博主', key: 'video_author', width: 15 },
    { header: '视频标题', key: 'video_title', width: 30 },
    { header: '视频链接', key: 'video_url', width: 40 }
  ];

  data.forEach(row => {
    sheet.addRow({
      score: row.score || 0,
      nickname: row.nickname || '',
      douyin_id: row.douyin_id || '',
      comment_text: row.comment_text || '',
      matched_keywords: row.matched_keywords || '',
      comment_time: row.comment_time
        ? new Date(row.comment_time * 1000).toLocaleString('zh-CN')
        : '',
      ip_label: row.ip_label || '',
      video_author: row.video_author || '',
      video_title: row.video_title || '',
      video_url: row.video_url || ''
    });
  });

  await workbook.xlsx.writeFile(filePath);
}

module.exports = { registerIpcHandlers };
