/**
 * 本地 HTTP 控制接口
 *
 * 提供 RESTful API 用于：
 *   1. 状态查询 / 统计查询
 *   2. 远程启动/停止搜索/监控
 *   3. 配置读写
 *   4. 数据导出
 *   5. 日志/错误查看
 *   6. 故障恢复
 *
 * 监听 127.0.0.1 默认端口 18911（可配置），仅本地可访问
 */

const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const { getStateMachine, STATES } = require('./stateMachine');
const { getErrorAnalyzer } = require('./errorAnalyzer');
const { getRecoveryManager } = require('./recovery');
const { getLogger } = require('./logger');
const database = require('./database');

const logger = getLogger('HttpServer');

const DEFAULT_PORT = 18911;
const DEFAULT_HOST = '127.0.0.1';

class HttpControlServer {
  constructor(options = {}) {
    this.port = options.port || DEFAULT_PORT;
    this.host = options.host || DEFAULT_HOST;
    /** @type {import('http').Server|null} */
    this.server = null;
    /** 路由表 */
    this.routes = [];
    /** IPC 句柄（由 main.js 注入） */
    this.handlers = {
      startSearch: null,
      stopSearch: null,
      startMonitor: null,
      stopMonitor: null,
      exportData: null,
      startXhsSearch: null,
      stopXhsSearch: null,
      startXhsMonitor: null,
      stopXhsMonitor: null,
      startXhsRecommend: null,
      stopXhsRecommend: null,
      pauseXhsRecommend: null,
      getXhsStats: null,
      getXhsMatches: null,
      exportXhsData: null
    };
  }

  /**
   * 注册 IPC 处理器
   */
  setHandlers(handlers) {
    Object.assign(this.handlers, handlers);
  }

  /**
   * 启动服务
   */
  start() {
    if (this.server) {
      logger.warn('HTTP 服务已启动，跳过重复启动');
      return;
    }
    this.server = http.createServer((req, res) => this._handle(req, res));
    this._registerRoutes();
    this.server.listen(this.port, this.host, () => {
      logger.info(`HTTP 控制服务已启动: http://${this.host}:${this.port}`);
    });
    this.server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        logger.warn(`端口 ${this.port} 被占用，尝试 ${this.port + 1}`);
        this.port += 1;
        this.server = null;
        this.start();
      } else {
        logger.error(`HTTP 服务异常: ${e.message}`);
      }
    });
  }

  /**
   * 关闭服务
   */
  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info('HTTP 控制服务已停止');
    }
  }

  _registerRoutes() {
    this.routes = [
      // ---------- 状态 ----------
      { method: 'GET',  path: '/api/status',         handler: this._status.bind(this) },
      { method: 'GET',  path: '/api/state',          handler: this._state.bind(this) },
      { method: 'GET',  path: '/api/actions',        handler: this._actions.bind(this) },
      { method: 'GET',  path: '/api/action/list',    handler: this._actionList.bind(this) },

      // ---------- 控制 ----------
      { method: 'POST', path: '/api/search/start',   handler: this._startSearch.bind(this) },
      { method: 'POST', path: '/api/search/stop',    handler: this._stopSearch.bind(this) },
      { method: 'POST', path: '/api/monitor/start',  handler: this._startMonitor.bind(this) },
      { method: 'POST', path: '/api/monitor/stop',   handler: this._stopMonitor.bind(this) },
      { method: 'POST', path: '/api/reset',          handler: this._reset.bind(this) },
      { method: 'POST', path: '/api/recover',        handler: this._recover.bind(this) },

      // ---------- 动作 API（系统控制接口） ----------
      // 通用调用：/api/action/{name}  body: {params}
      { method: 'POST', path: '/api/action/click',   handler: this._actionClick.bind(this) },
      { method: 'POST', path: '/api/action/hover',   handler: this._actionHover.bind(this) },
      { method: 'POST', path: '/api/action/type',    handler: this._actionType.bind(this) },
      { method: 'POST', path: '/api/action/scroll',  handler: this._actionScroll.bind(this) },
      { method: 'POST', path: '/api/action/keypress',handler: this._actionKeypress.bind(this) },
      { method: 'POST', path: '/api/action/evaluate',handler: this._actionEvaluate.bind(this) },
      { method: 'POST', path: '/api/action/find',    handler: this._actionFind.bind(this) },
      { method: 'POST', path: '/api/action/dump',    handler: this._actionDump.bind(this) },
      { method: 'POST', path: '/api/action/navigate',handler: this._actionNavigate.bind(this) },
      { method: 'POST', path: '/api/action/back',    handler: this._actionBack.bind(this) },
      { method: 'POST', path: '/api/action/run',     handler: this._actionRun.bind(this) },
      { method: 'POST', path: '/api/action/screenshot', handler: this._actionScreenshot.bind(this) },
      { method: 'POST', path: '/api/action/diagnose',handler: this._actionDiagnose.bind(this) },
      // 动态动作 - 任意 /api/action/{name} 自动分发
      { method: 'POST', path: /^\/api\/action\/(\w+)$/, handler: this._actionDynamic.bind(this) },

      // ---------- 网络抓包 ----------
      { method: 'GET',  path: '/api/network/log',    handler: this._networkLog.bind(this) },
      { method: 'GET',  path: '/api/network/recent', handler: this._networkRecent.bind(this) },
      { method: 'GET',  path: '/api/network/summary',handler: this._networkSummary.bind(this) },
      { method: 'GET',  path: '/api/network/search', handler: this._networkSearch.bind(this) },
      { method: 'POST', path: '/api/network/clear',  handler: this._networkClear.bind(this) },
      { method: 'POST', path: '/api/network/enable', handler: this._networkEnable.bind(this) },
      { method: 'POST', path: '/api/network/disable',handler: this._networkDisable.bind(this) },
      { method: 'POST', path: '/api/network/export', handler: this._networkExport.bind(this) },

      // ---------- 评论 ----------
      { method: 'GET',  path: '/api/comments',       handler: this._getComments.bind(this) },

      // ---------- 配置 ----------
      { method: 'GET',  path: '/api/config',         handler: this._getConfig.bind(this) },
      { method: 'POST', path: '/api/config',         handler: this._setConfig.bind(this) },

      // ---------- 数据 ----------
      { method: 'GET',  path: '/api/leads',          handler: this._getLeads.bind(this) },
      { method: 'GET',  path: '/api/leads/export',   handler: this._exportLeads.bind(this) },
      { method: 'GET',  path: '/api/stats',          handler: this._stats.bind(this) },

      // ---------- 日志 / 错误 ----------
      { method: 'GET',  path: '/api/errors',         handler: this._errors.bind(this) },
      { method: 'GET',  path: '/api/logs',           handler: this._logs.bind(this) },

      // ---------- 健康检查 ----------
      { method: 'GET',  path: '/health',             handler: this._health.bind(this) },

      // ---------- 小红书 ----------
      { method: 'POST', path: '/api/xhs/search/start',  handler: this._startXhsSearch.bind(this) },
      { method: 'POST', path: '/api/xhs/search/stop',   handler: this._stopXhsSearch.bind(this) },
      { method: 'POST', path: '/api/xhs/monitor/start', handler: this._startXhsMonitor.bind(this) },
      { method: 'POST', path: '/api/xhs/monitor/stop',  handler: this._stopXhsMonitor.bind(this) },
      { method: 'POST', path: '/api/xhs/recommend/start', handler: this._startXhsRecommend.bind(this) },
      { method: 'POST', path: '/api/xhs/recommend/stop',  handler: this._stopXhsRecommend.bind(this) },
      { method: 'POST', path: '/api/xhs/recommend/pause', handler: this._pauseXhsRecommend.bind(this) },
      { method: 'GET',  path: '/api/xhs/stats',         handler: this._xhsStats.bind(this) },
      { method: 'GET',  path: '/api/xhs/matches',       handler: this._xhsMatches.bind(this) },
      { method: 'GET',  path: '/api/xhs/leads/export',  handler: this._exportXhsLeads.bind(this) },
      { method: 'GET',  path: '/api/xhs/network/log',   handler: this._xhsNetworkLog.bind(this) },
      { method: 'GET',  path: '/api/xhs/network/summary', handler: this._xhsNetworkSummary.bind(this) },
      { method: 'GET',  path: '/api/xhs/comments',      handler: this._getXhsComments.bind(this) },
      { method: 'POST', path: '/api/xhs/action/evaluate', handler: this._xhsActionEvaluate.bind(this) },
      { method: 'POST', path: '/api/xhs/action/navigate', handler: this._xhsActionNavigate.bind(this) },
      { method: 'POST', path: '/api/xhs/action/screenshot', handler: this._xhsActionScreenshot.bind(this) },
      { method: 'GET',  path: '/api/xhs/health',        handler: this._xhsHealth.bind(this) },
      { method: 'POST', path: '/api/switch-platform',   handler: this._switchPlatform.bind(this) }
    ];
  }

  async _handle(req, res) {
    const parsed = url.parse(req.url, true);
    const method = req.method.toUpperCase();

    // CORS（仅本地，但仍允许本机其他工具调用）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 路由匹配（支持字符串与正则）
    let route = null;
    let routeMatches = null;
    for (const r of this.routes) {
      if (r.method !== method) continue;
      if (typeof r.path === 'string') {
        if (r.path === parsed.pathname) { route = r; break; }
      } else if (r.path instanceof RegExp) {
        const m = parsed.pathname.match(r.path);
        if (m) { route = r; routeMatches = m; break; }
      }
    }

    if (!route) {
      this._json(res, 404, { ok: false, error: 'Not Found', path: parsed.pathname });
      return;
    }

    try {
      const body = await this._readBody(req);
      await route.handler(req, res, parsed, body, routeMatches);
    } catch (e) {
      logger.error(`HTTP 处理异常 [${method} ${parsed.pathname}]: ${e.message}`);
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  _readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (!raw) return resolve({});
        try { return resolve(JSON.parse(raw)); }
        catch (_) { return resolve({ _raw: raw }); }
      });
      req.on('error', () => resolve({}));
    });
  }

  _json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
  }

  // ==================== 路由实现 ====================

  async _status(req, res) {
    const state = getStateMachine();
    this._json(res, 200, { ok: true, status: state.snapshot() });
  }

  async _state(req, res) {
    this._json(res, 200, { ok: true, state: getStateMachine().current });
  }

  async _actions(req, res) {
    this._json(res, 200, { ok: true, actions: getStateMachine().getNextActions() });
  }

  async _startSearch(req, res, _parsed, body) {
    if (this.handlers.startSearch) {
      try {
        const result = await this.handlers.startSearch(body || {});
        this._json(res, 200, { ok: true, result });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'startSearch 处理器未注册' });
    }
  }

  async _stopSearch(req, res) {
    if (this.handlers.stopSearch) {
      try {
        await this.handlers.stopSearch();
        this._json(res, 200, { ok: true });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'stopSearch 处理器未注册' });
    }
  }

  async _startMonitor(req, res) {
    if (this.handlers.startMonitor) {
      try {
        await this.handlers.startMonitor();
        this._json(res, 200, { ok: true });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'startMonitor 处理器未注册' });
    }
  }

  async _stopMonitor(req, res) {
    if (this.handlers.stopMonitor) {
      try {
        await this.handlers.stopMonitor();
        this._json(res, 200, { ok: true });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'stopMonitor 处理器未注册' });
    }
  }

  async _reset(req, res) {
    getStateMachine().forceReset('http_api');
    getRecoveryManager().reset();
    this._json(res, 200, { ok: true, message: '已重置为 IDLE' });
  }

  async _recover(req, res) {
    // 手动触发恢复
    const recovery = getRecoveryManager();
    const state = getStateMachine();
    if (state.current === STATES.ERROR) {
      state.transition(STATES.RECOVERING, { phase: 'manual_recover' });
      this._json(res, 200, { ok: true, message: '已触发恢复' });
    } else {
      this._json(res, 400, { ok: false, error: `当前状态 ${state.current} 无需恢复` });
    }
  }

  async _getConfig(req, res) {
    try {
      const config = require('./config');
      const cfg = config.loadConfig();
      this._json(res, 200, { ok: true, config: cfg });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _setConfig(req, res, _p, body) {
    try {
      if (body && body.config) {
        const config = require('./config');
        config.saveConfig(body.config);
        try { require('./notifier').reload(body.config); } catch (_) {}
        this._json(res, 200, { ok: true });
      } else {
        this._json(res, 400, { ok: false, error: '需要 config 字段' });
      }
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _getLeads(req, res, parsed) {
    try {
      const limit = Math.min(parseInt(parsed.query.limit) || 100, 1000);
      const offset = parseInt(parsed.query.offset) || 0;
      const raw = database.getLeads ? database.getLeads(limit, offset) : [];
      // 映射数据库列名到前端期望的字段名
      const leads = raw.map(r => ({
        id: r.id,
        aweme_id: r.aweme_id,
        comment_id: r.comment_id,
        nickname: r.nickname,
        douyin_id: r.douyin_id,
        sec_uid: r.sec_uid,
        profile_url: r.profile_url,
        text: r.comment_text,
        matched_keywords: r.matched_keywords,
        create_time: r.comment_time,
        ip_label: r.ip_label,
        video_author: r.video_author,
        video_desc: r.video_title,
        video_url: r.video_url,
        score: r.score,
        capture_time: r.capture_time,
        capture_date: r.capture_date,
        source: r.source || 'api'
      }));
      this._json(res, 200, { ok: true, leads, count: leads.length });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _exportLeads(req, res) {
    try {
      if (this.handlers.exportData) {
        const result = await this.handlers.exportData();
        this._json(res, 200, { ok: true, result });
      } else if (database.exportLeads) {
        const result = database.exportLeads();
        this._json(res, 200, { ok: true, result });
      } else {
        this._json(res, 503, { ok: false, error: '导出能力未注册' });
      }
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _stats(req, res) {
    try {
      const errStats = getErrorAnalyzer().getStats();
      const recoveryStats = getRecoveryManager().getStats();
      const dbStats = database.getStats ? database.getStats() : {};
      this._json(res, 200, { ok: true, errors: errStats, recovery: recoveryStats, database: dbStats });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _errors(req, res, parsed) {
    const limit = Math.min(parseInt(parsed.query.limit) || 50, 500);
    this._json(res, 200, { ok: true, errors: getErrorAnalyzer().getHistory(limit) });
  }

  async _logs(req, res, parsed) {
    try {
      const lines = Math.min(parseInt(parsed.query.lines) || 200, 5000);
      const logFile = path.join(__dirname, '..', 'logs', 'app.log');
      if (!fs.existsSync(logFile)) {
        this._json(res, 200, { ok: true, lines: [] });
        return;
      }
      const data = fs.readFileSync(logFile, 'utf-8');
      const all = data.split('\n').filter(l => l.trim());
      this._json(res, 200, { ok: true, lines: all.slice(-lines) });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _health(req, res) {
    const state = getStateMachine();
    this._json(res, 200, {
      ok: true,
      uptime: process.uptime(),
      state: state.current,
      ts: Date.now()
    });
  }

  // ==================== 小红书 API ====================

  async _startXhsSearch(req, res, _p, body) {
    if (this.handlers.startXhsSearch) {
      try {
        const result = await this.handlers.startXhsSearch(body || {});
        this._json(res, 200, { ok: true, result });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'startXhsSearch 处理器未注册' });
    }
  }

  async _stopXhsSearch(req, res) {
    if (this.handlers.stopXhsSearch) {
      try {
        await this.handlers.stopXhsSearch();
        this._json(res, 200, { ok: true });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'stopXhsSearch 处理器未注册' });
    }
  }

  async _startXhsMonitor(req, res) {
    if (this.handlers.startXhsMonitor) {
      try {
        await this.handlers.startXhsMonitor();
        this._json(res, 200, { ok: true });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'startXhsMonitor 处理器未注册' });
    }
  }

  async _stopXhsMonitor(req, res) {
    if (this.handlers.stopXhsMonitor) {
      try {
        await this.handlers.stopXhsMonitor();
        this._json(res, 200, { ok: true });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'stopXhsMonitor 处理器未注册' });
    }
  }

  async _xhsStats(req, res) {
    try {
      const stats = this.handlers.getXhsStats ? await this.handlers.getXhsStats() : database.getXHSStats();
      this._json(res, 200, { ok: true, stats });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _xhsMatches(req, res, parsed) {
    try {
      const limit = Math.min(parseInt(parsed.query.limit) || 50, 500);
      const offset = parseInt(parsed.query.offset) || 0;
      if (this.handlers.getXhsMatches) {
        const result = await this.handlers.getXhsMatches({ offset, limit });
        this._json(res, 200, { ok: true, ...result });
      } else {
        const items = database.getXHSRecentMatchesPage(offset, limit, {});
        const total = database.getXHSMatchesCount({});
        this._json(res, 200, { ok: true, items, total });
      }
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _startXhsRecommend(req, res, _p, body) {
    if (this.handlers.startXhsRecommend) {
      try {
        const result = await this.handlers.startXhsRecommend(body || {});
        this._json(res, 200, { ok: true, result });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'startXhsRecommend 处理器未注册' });
    }
  }

  async _stopXhsRecommend(req, res) {
    if (this.handlers.stopXhsRecommend) {
      try {
        await this.handlers.stopXhsRecommend();
        this._json(res, 200, { ok: true });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'stopXhsRecommend 处理器未注册' });
    }
  }

  async _pauseXhsRecommend(req, res) {
    if (this.handlers.pauseXhsRecommend) {
      try {
        await this.handlers.pauseXhsRecommend();
        this._json(res, 200, { ok: true });
      } catch (e) {
        this._json(res, 400, { ok: false, error: e.message });
      }
    } else {
      this._json(res, 503, { ok: false, error: 'pauseXhsRecommend 处理器未注册' });
    }
  }

  async _exportXhsLeads(req, res) {
    try {
      if (this.handlers.exportXhsData) {
        const result = await this.handlers.exportXhsData();
        this._json(res, 200, { ok: true, result });
      } else {
        // 直接从数据库导出
        const items = database.getXHSRecentMatchesPage(0, 10000, {});
        this._json(res, 200, { ok: true, items, count: items.length });
      }
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _xhsNetworkLog(req, res, parsed) {
    try {
      const { getXHSCdpInterceptor } = require('../main/window');
      const cdp = getXHSCdpInterceptor();
      if (!cdp || !cdp.allRequests) return this._json(res, 503, { ok: false, error: 'XHS CDP未启动' });
      const urlFilter = parsed.query.url || parsed.query.urlContains;
      let log = cdp.allRequests.slice();
      if (urlFilter) log = log.filter(r => r.url && r.url.includes(urlFilter));
      const limit = Math.min(parseInt(parsed.query.limit) || 100, 1000);
      log = log.slice(-limit);
      this._json(res, 200, { ok: true, log, count: log.length });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _xhsNetworkSummary(req, res) {
    try {
      const { getXHSCdpInterceptor } = require('../main/window');
      const cdp = getXHSCdpInterceptor();
      if (!cdp) return this._json(res, 503, { ok: false, error: 'XHS CDP未启动' });
      this._json(res, 200, { ok: true, summary: cdp._stats || { total: 0 } });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _getXhsComments(req, res, parsed) {
    try {
      const { getXHSCdpInterceptor } = require('../main/window');
      const cdp = getXHSCdpInterceptor();
      if (!cdp) return this._json(res, 503, { ok: false, error: 'XHS CDP未启动' });
      const noteId = parsed.query.noteId || parsed.query.note_id;
      const comments = noteId ? (cdp.comments[noteId] || []) : [];
      this._json(res, 200, { ok: true, comments, count: comments.length });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _xhsActionEvaluate(req, res, _p, body) {
    try {
      const { getXHSView } = require('../main/window');
      const view = getXHSView();
      if (!view || !view.webContents) return this._json(res, 503, { ok: false, error: 'XHS浏览器未就绪' });
      const script = (body || {}).script;
      if (!script) return this._json(res, 400, { ok: false, error: '需要script参数' });
      const result = await view.webContents.executeJavaScript(script);
      this._json(res, 200, { ok: true, result });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _xhsActionNavigate(req, res, _p, body) {
    try {
      const { getXHSView } = require('../main/window');
      const view = getXHSView();
      if (!view || !view.webContents) return this._json(res, 503, { ok: false, error: 'XHS浏览器未就绪' });
      const url = (body || {}).url;
      if (!url) return this._json(res, 400, { ok: false, error: '需要url参数' });
      await view.webContents.loadURL(url);
      this._json(res, 200, { ok: true, url });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _xhsActionScreenshot(req, res) {
    try {
      const { getXHSView } = require('../main/window');
      const view = getXHSView();
      if (!view || !view.webContents) return this._json(res, 503, { ok: false, error: 'XHS浏览器未就绪' });
      const image = await view.webContents.capturePage();
      const base64 = image.toPNG().toString('base64');
      this._json(res, 200, { ok: true, image: base64, format: 'png' });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _xhsHealth(req, res) {
    try {
      const { getXHSView, getXHSCdpInterceptor } = require('../main/window');
      const view = getXHSView();
      const cdp = getXHSCdpInterceptor();
      this._json(res, 200, {
        ok: true,
        viewReady: !!(view && view.webContents),
        cdpReady: !!cdp,
        uptime: process.uptime(),
        ts: Date.now()
      });
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  async _switchPlatform(req, res, _p, body) {
    try {
      const platform = (body || {}).platform || 'xhs';
      const { createXHSWindow, getXHSWindow } = require('../main/window');
      if (platform === 'xhs') {
        const xhsWin = createXHSWindow();
        if (xhsWin) { xhsWin.show(); xhsWin.focus(); }
        this._json(res, 200, { ok: true, platform: 'xhs', windowCreated: !!xhsWin });
      } else {
        this._json(res, 200, { ok: true, platform: 'douyin' });
      }
    } catch (e) {
      this._json(res, 500, { ok: false, error: e.message });
    }
  }

  // ==================== 动作 API 处理器 ====================

  _getActionApi() {
    try { return require('./actionApi'); }
    catch (e) {
      logger.error('actionApi 加载失败: ' + e.message);
      return null;
    }
  }

  _getCdp() {
    try {
      const api = require('./actionApi');
      return api.ensureCdp ? api.ensureCdp() : null;
    } catch (_) { return null; }
  }

  async _actionList(req, res) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    this._json(res, 200, { ok: true, actions: api.getActionsList() });
  }

  async _actionClick(req, res, _p, body) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.click(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionHover(req, res, _p, body) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.hover(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionType(req, res, _p, body) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.type(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionScroll(req, res, _p, body) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.scroll(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionKeypress(req, res, _p, body) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.keypress(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionEvaluate(req, res, _p, body) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.evaluate(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionFind(req, res, _p, body) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.findElement(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionDump(req, res, _p, body) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.dumpDOM(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionNavigate(req, res, _p, body) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.navigate(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionBack(req, res) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.goBack();
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionRun(req, res, _p, body) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.runSequence(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionScreenshot(req, res) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.screenshot();
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _actionDiagnose(req, res) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.diagnose();
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  // 动态动作分发
  async _actionDynamic(req, res, _p, body, matches) {
    const name = matches && matches[1];
    if (!name) return this._json(res, 400, { ok: false, error: 'no_action_name' });
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    const fn = api.ACTIONS && api.ACTIONS[name];
    if (!fn) return this._json(res, 404, { ok: false, error: 'unknown_action', name, available: api.getActionsList().map(a => a.name) });
    try {
      const r = await fn(body || {});
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  // ==================== 网络抓包 API ====================

  async _networkLog(req, res, parsed) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.getNetworkLog({
        urlContains: parsed.query.url || parsed.query.urlContains,
        method: parsed.query.method,
        from: parsed.query.from ? parseInt(parsed.query.from) : null,
        to: parsed.query.to ? parseInt(parsed.query.to) : null,
        hasResponse: parsed.query.hasResponse ? (parsed.query.hasResponse === 'true') : undefined,
        maxBytes: parsed.query.maxBytes ? parseInt(parsed.query.maxBytes) : null,
        full: parsed.query.full === 'true'
      });
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _networkRecent(req, res, parsed) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    const n = parseInt(parsed.query.n) || 50;
    try {
      const r = await api.getNetworkLog({ full: parsed.query.full === 'true' });
      if (r.ok) {
        r.data.log = r.data.log.slice(-n);
        r.data.count = r.data.log.length;
      }
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _networkSummary(req, res) {
    const cdp = this._getCdp();
    if (!cdp) return this._json(res, 503, { ok: false, error: 'cdp_unavailable' });
    this._json(res, 200, { ok: true, summary: cdp.getLastSummary ? cdp.getLastSummary() : { count: 0 } });
  }

  async _networkSearch(req, res, parsed) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    const keyword = parsed.query.q || parsed.query.keyword;
    if (!keyword) return this._json(res, 400, { ok: false, error: 'keyword_required' });
    try {
      const r = await api.searchNetworkLog({ keyword, full: parsed.query.full === 'true' });
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _networkClear(req, res) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.clearNetworkLog();
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _networkEnable(req, res) {
    const cdp = this._getCdp();
    if (!cdp) return this._json(res, 503, { ok: false, error: 'cdp_unavailable' });
    cdp.setCaptureEnabled(true);
    this._json(res, 200, { ok: true, enabled: true });
  }

  async _networkDisable(req, res) {
    const cdp = this._getCdp();
    if (!cdp) return this._json(res, 503, { ok: false, error: 'cdp_unavailable' });
    cdp.setCaptureEnabled(false);
    this._json(res, 200, { ok: true, enabled: false });
  }

  async _networkExport(req, res, _p, body) {
    const cdp = this._getCdp();
    if (!cdp) return this._json(res, 503, { ok: false, error: 'cdp_unavailable' });
    const filePath = (body && body.path) || path.join(__dirname, '..', 'logs', `network-${Date.now()}.ndjson`);
    try {
      const r = cdp.exportToFile(filePath);
      this._json(res, r.ok ? 200 : 500, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  async _getComments(req, res, parsed) {
    const api = this._getActionApi();
    if (!api) return this._json(res, 503, { ok: false, error: 'actionApi_unavailable' });
    try {
      const r = await api.getComments({ aid: parsed.query.aid || parsed.query.awemeId });
      this._json(res, r.ok ? 200 : 400, r);
    } catch (e) { this._json(res, 500, { ok: false, error: e.message }); }
  }

  // ---------- 私有 ----------
  _json(res, code, body) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }
}

let instance = null;
function getHttpServer(options) {
  if (!instance) instance = new HttpControlServer(options);
  return instance;
}

module.exports = { getHttpServer, HttpControlServer };
