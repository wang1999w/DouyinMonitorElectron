/**
 * 主进程入口文件
 * 负责：应用生命周期管理、窗口创建、模块初始化、全局异常处理
 */

const { app, BrowserWindow, protocol, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { createMainWindow, getMainWindow, getDouyinView, createXHSWindow, getXHSWindow, getXHSView, getXHSCdpInterceptor } = require('./window');
const { setupWebRequest } = require('./webRequest');
const { registerIpcHandlers } = require('./ipc');
const { getStateMachine, STATES } = require('../core/stateMachine');
const { getErrorAnalyzer } = require('../core/errorAnalyzer');
const { getRecoveryManager } = require('../core/recovery');
const { getHttpServer } = require('../core/httpServer');

let mainWindow = null;
const BLOCKED_PROTOCOLS = ['bytedance', 'sslocal', 'snssdk', 'aweme'];

// ========== 环境自检 ==========

function envCheck() {
  const issues = [];

  // 检查目录
  const dirs = ['logs', 'core', 'main', 'renderer', 'preload'];
  for (const d of dirs) {
    const p = path.join(__dirname, '..', d);
    if (!fs.existsSync(p)) issues.push(`目录缺失: ${d}`);
  }

  // 检查核心模块
  const modules = ['search.js', 'monitor.js', 'pipeline.js', 'database.js', 'config.js', 'match.js', 'email.js', 'wechat.js', 'cdpInterceptor.js', 'humanBehavior.js'];
  for (const m of modules) {
    const p = path.join(__dirname, '..', 'core', m);
    if (!fs.existsSync(p)) issues.push(`核心模块缺失: ${m}`);
  }

  // 检查数据库目录可写
  const dbPath = path.join(__dirname, '..', 'monitor.db');
  try {
    fs.accessSync(path.dirname(dbPath), fs.constants.W_OK);
  } catch (e) {
    issues.push('数据库目录不可写');
  }

  // 检查配置文件
  const cfgPath = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    } catch (e) {
      issues.push(`配置文件损坏: ${e.message}`);
    }
  }

  return issues;
}

// ========== 全局异常处理 ==========

/** 未捕获异常：记录日志 → 通知用户 → 尝试恢复 */
process.on('uncaughtException', (err) => {
  const msg = `未捕获异常: ${err.message}\n${err.stack}`;
  console.error(msg);
  notifyRenderer('error-notify', msg);
  // 接入错误分析器
  try {
    const analyzed = getErrorAnalyzer().analyze(err, { phase: 'uncaught' });
    getStateMachine().setError(analyzed.message, { category: analyzed.category });
    // 触发自动恢复（非致命则尝试）
    if (analyzed.severity !== 'fatal') {
      getRecoveryManager().autoRecover(analyzed, { phase: 'uncaught' }).catch(() => {});
    }
  } catch (_) {}
  // 不退出进程，尝试继续运行
});

/** 未处理的 Promise 拒绝 */
process.on('unhandledRejection', (reason) => {
  const msg = `未处理Promise拒绝: ${reason instanceof Error ? reason.message : String(reason)}`;
  console.error(msg);
  notifyRenderer('error-notify', msg);
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    const analyzed = getErrorAnalyzer().analyze(err, { phase: 'unhandled_rejection' });
    getStateMachine().setError(analyzed.message, { category: analyzed.category });
  } catch (_) {}
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
      dialog.showErrorBox('CW自媒体监控系统 - 异常', message);
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

  // 绑定 actionApi 与各业务模块（让 HTTP API 能调用底层能力）
  try {
    const actionApi = require('../core/actionApi');
    const searchEngine = require('../core/search');
    const videoProcessor = require('../core/videoProcessor');
    const { getCDPInterceptor } = require('./window');
    actionApi.bind({
      getDouyinView: () => getDouyinView(),
      searchEngine,
      // 关键：传 getter 函数，不要在 init 时立即取值（CDP 还没创建）
      getCdpInterceptor: getCDPInterceptor,
      videoProcessor
    });
    console.log('[init] actionApi 已绑定');
  } catch (e) {
    console.error('[init] actionApi 绑定失败:', e.message);
  }

  // 监听渲染进程崩溃
  mainWindow.on('render-process-gone', (event, details) => {
    console.error('渲染进程崩溃:', details.reason);
    notifyRenderer('error-notify', `渲染进程崩溃: ${details.reason}`);
    // 标记状态
    try {
      getStateMachine().setError(`渲染进程崩溃: ${details.reason}`, { category: 'browser_crashed' });
    } catch (_) {}
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

// ========== 启动前清理缓存 ==========

function cleanAppCache() {
  try {
    const userDataPath = app.getPath('userData');
    // 注意：不要清理 Network（Cookie/登录会话）、Cache、Code Cache（可能导致崩溃）
    // 只清理 GPUCache 和 DawnCache（GPU相关缓存，安全可删）
    const cacheDirs = ['GPUCache', 'DawnCache'];
    for (const dir of cacheDirs) {
      const dirPath = path.join(userDataPath, dir);
      if (fs.existsSync(dirPath)) {
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (_) {}
      }
    }
  } catch (_) {}
}

// ========== 启动 ==========

app.whenReady().then(() => {
  // 启动前清理缓存（防止tmp文件积累导致崩溃）
  cleanAppCache();
  // 环境自检
  const issues = envCheck();
  if (issues.length > 0) {
    console.error('环境自检发现问题:');
    issues.forEach(i => console.error('  - ' + i));
  } else {
    console.log('环境自检通过 ✓');
  }

  registerProtocolHandlers();
  initApp();

  // 自检结果发送到渲染进程（等待窗口加载完成）
  const envMsg = issues.length > 0
    ? `环境自检完成，${issues.length}个问题: ${issues.join('; ')}`
    : '环境自检通过 ✓';

  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('search-log', `[系统] ${envMsg}`);
    });
  }

  // 启动时初始化通知器
  try {
    const cfg = require('../core/config').loadConfig();
    require('../core/notifier').reload(cfg);
  } catch (e) {}

  const scheduler = require('../core/scheduler');
  scheduler.init((msg) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('scheduler-log', msg);
    }
  });

  // 日志记录启动信息
  try {
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(logDir, `${date}.log`);
    const startMsg = `[${new Date().toLocaleString()}] [SYSTEM] 应用启动, 环境自检${issues.length > 0 ? issues.length + '个问题' : '通过'}\n`;
    fs.appendFileSync(logFile, startMsg);
  } catch (e) {}

  // 启动 HTTP 控制服务（默认 127.0.0.1:18911）
  try {
    const httpServer = getHttpServer({ host: '127.0.0.1', port: 18911 });
    httpServer.setHandlers({
      startSearch: async (params) => {
        const { ipcMain: _ipc } = require('electron');
        // 通过模拟 IPC 调用启动搜索
        const searchEngine = require('../core/search');
        searchEngine.startSearch(
          params || {},
          (msg) => mainWindow && mainWindow.webContents.send('search-log', msg),
          (result) => mainWindow && mainWindow.webContents.send('search-result', result),
          (progress) => mainWindow && mainWindow.webContents.send('search-progress', progress)
        );
        return { started: true, params: params || {} };
      },
      stopSearch: async () => {
        require('../core/search').stopSearch();
        return { stopped: true };
      },
      startMonitor: async () => {
        const monitorEngine = require('../core/monitor');
        monitorEngine.startMonitor(
          (msg) => mainWindow && mainWindow.webContents.send('monitor-log', msg),
          (progress) => mainWindow && mainWindow.webContents.send('monitor-progress', progress)
        );
        return { started: true };
      },
      stopMonitor: async () => {
        require('../core/monitor').stopMonitor();
        return { stopped: true };
      },
      exportData: async () => {
        const database = require('../core/database');
        const fsLocal = require('fs');
        const pathLocal = require('path');
        const dir = pathLocal.join(__dirname, '..', 'exports');
        if (!fsLocal.existsSync(dir)) fsLocal.mkdirSync(dir, { recursive: true });
        const file = pathLocal.join(dir, `leads_${Date.now()}.json`);
        const leads = database.getLeads ? database.getLeads(1000, 0) : [];
        fsLocal.writeFileSync(file, JSON.stringify(leads, null, 2));
        return { path: file, count: leads.length };
      },
      // ========== 小红书 HTTP API ==========
      startXhsSearch: async (params) => {
        const xhsSearchEngine = require('../core/search-xhs');
        const xhsWin = getXHSWindow();
        xhsSearchEngine.startSearch(
          params || {},
          (msg) => xhsWin && !xhsWin.isDestroyed() && xhsWin.webContents.send('xhs-search-log', msg),
          (result) => xhsWin && !xhsWin.isDestroyed() && xhsWin.webContents.send('xhs-search-result', result),
          (progress) => xhsWin && !xhsWin.isDestroyed() && xhsWin.webContents.send('xhs-search-progress', progress),
          () => getXHSView(),
          () => getXHSCdpInterceptor()
        );
        return { started: true, params: params || {} };
      },
      stopXhsSearch: async () => {
        require('../core/search-xhs').stopSearch();
        return { stopped: true };
      },
      startXhsMonitor: async () => {
        const xhsMonitorEngine = require('../core/monitor-xhs');
        const xhsWin = getXHSWindow();
        xhsMonitorEngine.startMonitor(
          (msg) => xhsWin && !xhsWin.isDestroyed() && xhsWin.webContents.send('xhs-monitor-log', msg),
          (result) => xhsWin && !xhsWin.isDestroyed() && xhsWin.webContents.send('xhs-monitor-result', result),
          (progress) => xhsWin && !xhsWin.isDestroyed() && xhsWin.webContents.send('xhs-monitor-progress', progress),
          () => getXHSView(),
          () => getXHSCdpInterceptor()
        );
        return { started: true };
      },
      stopXhsMonitor: async () => {
        require('../core/monitor-xhs').stopMonitor();
        return { stopped: true };
      },
      getXhsStats: async () => {
        const database = require('../core/database');
        return database.getXHSStats();
      },
      getXhsMatches: async (params) => {
        const database = require('../core/database');
        const offset = (params && params.offset) || 0;
        const limit = (params && params.limit) || 50;
        return {
          items: database.getXHSRecentMatchesPage(offset, limit, {}),
          total: database.getXHSMatchesCount({})
        };
      },
      startXhsRecommend: async (params) => {
        const xhsRecommend = require('../core/recommend-xhs');
        const xhsWin = getXHSWindow();
        xhsRecommend.startRecommend(
          params || {},
          (msg) => xhsWin && !xhsWin.isDestroyed() && xhsWin.webContents.send('xhs-recommend-log', msg),
          (result) => xhsWin && !xhsWin.isDestroyed() && xhsWin.webContents.send('xhs-recommend-result', result),
          (progress) => xhsWin && !xhsWin.isDestroyed() && xhsWin.webContents.send('xhs-recommend-progress', progress),
          () => getXHSView(),
          () => getXHSCdpInterceptor()
        );
        return { started: true, params: params || {} };
      },
      stopXhsRecommend: async () => {
        require('../core/recommend-xhs').stopRecommend();
        return { stopped: true };
      },
      pauseXhsRecommend: async () => {
        require('../core/recommend-xhs').pauseRecommend();
        return { paused: true };
      },
      exportXhsData: async () => {
        const database = require('../core/database');
        const items = database.getXHSRecentMatchesPage(0, 10000, {});
        return { items, count: items.length };
      }
    });
    httpServer.start();
    // 标记状态机已就绪
    getStateMachine().setPhase('ready', { httpPort: 18911 });
  } catch (e) {
    console.error('HTTP 控制服务启动失败:', e.message);
  }

  // 启动内存看门狗（60s 检测一次，超过 1.5GB 触发 GC + 告警）
  startMemoryWatchdog();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) initApp();
  });
});

/**
 * 内存看门狗：周期性检查主进程与渲染进程内存
 * 超过阈值时主动告警 + 提示 GC
 */
function startMemoryWatchdog() {
  const MEM_WARN_MB = 1024;       // 1GB 警告
  const MEM_CRITICAL_MB = 1536;   // 1.5GB 严重
  const CHECK_INTERVAL_MS = 60000;

  setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      const rssMB = Math.round(mem.rss / 1024 / 1024);

      if (rssMB > MEM_CRITICAL_MB) {
        const msg = `主进程内存过高: RSS=${rssMB}MB / Heap=${heapMB}MB`;
        console.error(msg);
        getStateMachine().setError(msg, { category: 'memory_pressure' });
        // 提示 GC（仅在 --expose-gc 下有效）
        if (global.gc) {
          try { global.gc(); console.log('已触发主进程 GC'); } catch (_) {}
        }
      } else if (rssMB > MEM_WARN_MB) {
        console.warn(`主进程内存偏高: RSS=${rssMB}MB / Heap=${heapMB}MB`);
      }
    } catch (e) {
      // 静默失败
    }
  }, CHECK_INTERVAL_MS);
}

app.on('window-all-closed', () => {
  // 退出前刷盘：日志、数据库、状态机
  try {
    const logger = require('../core/logger');
    logger.flush();
    const database = require('../core/database');
    if (database && database.flushDatabase) database.flushDatabase().catch(() => {});
    const { stopStatsBroadcaster } = require('./ipc');
    if (stopStatsBroadcaster) stopStatsBroadcaster();
    // 停止 HTTP 服务
    try { getHttpServer().stop(); } catch (_) {}
    // 状态机刷盘
    getStateMachine().flush();
  } catch (e) {
    console.error('退出时清理失败:', e.message);
  }
  // macOS 不退出，其他平台只在主窗口关闭时才退出
  // 注意：小红书窗口是独立BrowserWindow，关闭它不应触发应用退出
  if (process.platform !== 'darwin') {
    const { getXHSWindow } = require('./window');
    const xhsWin = getXHSWindow();
    // 如果只剩XHS窗口关闭了，但主窗口还在，不退出
    const mainWin = getMainWindow();
    if (!mainWin || mainWin.isDestroyed()) {
      app.quit();
    }
    // 主窗口还在，不退出
  }
});

app.on('before-quit', () => {
  try {
    const logger = require('../core/logger');
    logger.flush();
    const database = require('../core/database');
    if (database && database.flushDatabase) database.flushDatabase().catch(() => {});
  } catch (e) {}
});
