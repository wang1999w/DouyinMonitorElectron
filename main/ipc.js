/**
 * IPC 通信注册模块（重构版）
 *
 * 负责：注册所有主进程 ↔ 渲染进程的 IPC 事件处理
 * 使用 ipcMain.handle 处理渲染进程的 invoke 请求
 *
 * 重构要点：
 *   - addBlogger 按 sec_uid 查重
 *   - 博主支持编辑（updateBlogger）
 *   - stats-updated 定时主动推送给渲染进程
 *   - 导出改为分页流式写入，避免 OOM
 *   - 所有 list 查询支持分页
 */

const { ipcMain, dialog, app } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { getLogger } = require('../core/logger');

const logger = getLogger('IPC');

let database = null;
let config = null;
let matchModule = null;
let emailModule = null;
let wechatModule = null;
let notifier = null;
let searchEngine = null;
let monitorEngine = null;
let statsTimer = null;

let dbReady = false;

function loadCoreModules() {
  if (!database) {
    database = require('../core/database');
    database.initDatabase().then(() => { dbReady = true; }).catch((e) => {
      console.error('数据库初始化失败:', e.message);
      dbReady = true; // 即使失败也标记为 ready，避免阻塞
    });
    config = require('../core/config');
    matchModule = require('../core/match');
    emailModule = require('../core/email');
    wechatModule = require('../core/wechat');
    notifier = require('../core/notifier');
    searchEngine = require('../core/search');
    monitorEngine = require('../core/monitor');
  }
}

async function ensureDbReady() {
  if (!database) loadCoreModules();
  // 等待数据库初始化完成（最多5秒）
  for (let i = 0; i < 10; i++) {
    if (dbReady) return;
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * 注册所有 IPC 处理器
 * @param {BrowserWindow} mainWindow
 */
function registerIpcHandlers(mainWindow) {
  // ========== 配置 ==========
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

  // ========== 统计 ==========
  ipcMain.handle('get-stats', async () => {
    await ensureDbReady();
    return database.getStats();
  });

  // ========== 博主管理 ==========
  ipcMain.handle('add-blogger', (event, blogger) => {
    loadCoreModules();
    const cfg = config.loadConfig();
    cfg.monitor_bloggers = cfg.monitor_bloggers || [];
    if (blogger.sec_uid) {
      const exists = cfg.monitor_bloggers.some(b => b.sec_uid === blogger.sec_uid);
      if (exists) return { success: false, error: '该博主已在监控列表中' };
    }
    cfg.monitor_bloggers.push(blogger);
    config.saveConfig(cfg);
    return { success: true };
  });

  ipcMain.handle('update-blogger', (event, { secUid, updates }) => {
    loadCoreModules();
    const cfg = config.loadConfig();
    cfg.monitor_bloggers = cfg.monitor_bloggers || [];
    const idx = cfg.monitor_bloggers.findIndex(b => b.sec_uid === secUid);
    if (idx < 0) return { success: false, error: '博主不存在' };
    cfg.monitor_bloggers[idx] = { ...cfg.monitor_bloggers[idx], ...updates };
    config.saveConfig(cfg);
    return { success: true };
  });

  ipcMain.handle('del-blogger', (event, identifier) => {
    loadCoreModules();
    const cfg = config.loadConfig();
    if (!cfg.monitor_bloggers) return { success: true };
    if (typeof identifier === 'number') {
      if (cfg.monitor_bloggers[identifier]) cfg.monitor_bloggers.splice(identifier, 1);
    } else if (typeof identifier === 'string') {
      cfg.monitor_bloggers = cfg.monitor_bloggers.filter(b => b.sec_uid !== identifier);
    }
    config.saveConfig(cfg);
    return { success: true };
  });

  // ========== 搜索 ==========
  ipcMain.handle('start-search', (event, params) => {
    loadCoreModules();
    searchEngine.startSearch(
      params,
      (msg) => mainWindow.webContents.send('search-log', msg),
      (result) => mainWindow.webContents.send('search-result', result),
      (progress) => mainWindow.webContents.send('search-progress', progress)
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

  // ========== 监控 ==========
  ipcMain.handle('start-monitor', () => {
    loadCoreModules();
    monitorEngine.startMonitor(
      (msg) => mainWindow.webContents.send('monitor-log', msg),
      (progress) => mainWindow.webContents.send('monitor-progress', progress)
    );
    return { success: true };
  });

  ipcMain.handle('stop-monitor', () => {
    loadCoreModules();
    monitorEngine.stopMonitor();
    return { success: true };
  });

  // ========== 意向评论查询（分页） ==========
  ipcMain.handle('get-matches-page', (event, { offset, limit, filter }) => {
    loadCoreModules();
    return {
      items: database.getRecentMatchesPage(offset || 0, limit || 50, filter || {}),
      total: database.getMatchesCount(filter || {})
    };
  });

  ipcMain.handle('clear-matches', () => {
    loadCoreModules();
    database.clearIntentComments();
    return { success: true };
  });

  // ========== 导出（流式分页） ==========
  ipcMain.handle('export-results', async (event, { filter } = {}) => {
    loadCoreModules();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出意向评论',
      defaultPath: `意向评论_${new Date().toISOString().slice(0, 10)}.xlsx`,
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
    });
    if (canceled || !filePath) return { success: false, canceled: true };

    try {
      await exportToExcelStream(filter || {}, filePath);
      return { success: true, path: filePath };
    } catch (err) {
      logger.error(`导出失败: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ========== 邮件 / 企微 测试 ==========
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

  // ========== BrowserView 显隐（模态框） ==========
  const { getDouyinView } = require('./window');

  ipcMain.handle('hide-douyin-view', () => {
    const view = getDouyinView();
    if (view) { try { mainWindow.removeBrowserView(view); } catch (e) {} }
    return { success: true };
  });

  ipcMain.handle('show-douyin-view', () => {
    const view = getDouyinView();
    if (view) { try { mainWindow.setBrowserView(view); } catch (e) {} }
    return { success: true };
  });

  // ========== 启动 stats 主动推送 ==========
  startStatsBroadcaster(mainWindow);
}

/**
 * 定时推送 stats 给渲染进程（5 秒一次）
 */
function startStatsBroadcaster(mainWindow) {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!database) return;
    try {
      mainWindow.webContents.send('stats-updated', database.getStats());
    } catch (e) {}
  }, 5000);
}

function stopStatsBroadcaster() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
}

/**
 * 分页流式导出到 Excel（每页 500 条，避免大表 OOM）
 */
async function exportToExcelStream(filter, filePath) {
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
    { header: '视频链接', key: 'video_url', width: 40 },
    { header: '用户主页', key: 'profile_url', width: 40 },
    { header: '采集时间', key: 'capture_time', width: 18 }
  ];

  const PAGE = 500;
  let offset = 0;
  const total = database.getMatchesCount(filter);
  let written = 0;

  while (offset < total) {
    const rows = database.getRecentMatchesPage(offset, PAGE, filter);
    if (rows.length === 0) break;

    for (const row of rows) {
      sheet.addRow({
        score: row.score || 0,
        nickname: row.nickname || '',
        douyin_id: row.douyin_id || '',
        comment_text: row.comment_text || '',
        matched_keywords: row.matched_keywords || '',
        comment_time: row.comment_time
          ? new Date(row.comment_time * 1000).toLocaleString('zh-CN') : '',
        ip_label: row.ip_label || '',
        video_author: row.video_author || '',
        video_title: row.video_title || '',
        video_url: row.video_url || '',
        profile_url: row.profile_url || '',
        capture_time: row.capture_time
          ? new Date(row.capture_time * 1000).toLocaleString('zh-CN') : ''
      });
      written++;
    }

    offset += PAGE;
  }

  await workbook.xlsx.writeFile(filePath);
  logger.info(`导出完成：${written} 条 -> ${filePath}`);
}

module.exports = { registerIpcHandlers, stopStatsBroadcaster };
