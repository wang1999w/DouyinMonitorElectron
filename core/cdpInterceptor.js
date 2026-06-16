/**
 * CDP 网络响应拦截器（重构版）
 *
 * 通过 Chrome DevTools Protocol 拦截完整的 HTTP 响应体
 * 提取评论 API 的 JSON 数据，获取完整的用户信息
 *
 * 采集字段完整清单：
 *   comment_id   评论ID
 *   uid          用户ID
 *   nickname     用户名称
 *   text         评论内容
 *   ip_label     IP属地
 *   create_time  评论时间
 *   sec_uid      用户主页ID
 *   profile_url  用户主页链接
 *   aweme_id     视频ID
 *   author       博主名称
 *   desc         视频文案
 *   video_url    视频链接
 *
 * 重构要点：
 *   - 显式 beginCollect / endCollect 生命周期，避免 currentVideo/comments 跨视频泄漏
 *   - LRU 淘汰所有评论缓存，防止内存无限增长
 *   - debugger.on('detach') 监听，意外断开时自动清理状态
 *   - processComment 数据去重使用 comment_id（API 可能分页返回）
 */

const { getLogger } = require('./logger');
const logger = getLogger('CDPInterceptor');

const COMMENT_API_PATTERNS = [
  '/comment/list',
  '/comment/list_reply',
  '/comment/publish'
];

const VIDEO_API_PATTERNS = [
  '/aweme/v1/web/aweme/detail',
  '/aweme/post',
  '/aweme/v1/web/tab/feed'
];

const SEARCH_API_PATTERNS = [
  '/web/general/search/single',
  '/web/search/item'
];

// 评论缓存最大保留视频数（LRU 淘汰）
const MAX_CACHED_VIDEOS = 200;

class CDPInterceptor {
  constructor(options = {}) {
    // 实例ID（用于诊断多实例问题）
    this._instanceId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    /** @type {Object<string, Array>} aweme_id -> 评论列表 */
    this.comments = {};
    /** 评论访问顺序（用于 LRU 淘汰） */
    this.commentKeys = [];
    /** 搜索结果中的视频信息 */
    this.searchVideos = [];
    /** 当前正在查看的视频信息（每次 beginCollect 时清空） */
    this.currentVideo = null;
    /** 采集目标 aweme_id（beginCollect 时设置） */
    this.collectTarget = null;
    /** 已拦截的请求 ID 集合（防重复处理） */
    this.processedIds = new Set();
    /** 回调 */
    this.onComment = null;
    this.onVideo = null;
    /** Feed 缓存（首页推荐视频） */
    this.feedCache = new Map();
    /** 最近一次评论发布结果 */
    this.lastPublishResult = null;
    /** debugger 句柄 */
    this._webContents = null;
    this._messageHandler = null;
    this._detachHandler = null;
    // ===== 新增：全量网络抓包 =====
    /** 全量网络请求日志（按时间顺序） */
    this.allRequests = [];
    /** 请求 ID -> 请求对象映射（用于补全响应） */
    this._requestMap = new Map();
    /** 累计统计 */
    this._stats = { total: 0, byDomain: {}, byMethod: {}, byStatus: {} };
    /** 抓包是否启用（默认 true；可通过 setCaptureEnabled 切换） */
    this._captureEnabled = options.captureEnabled !== false;
    /** 抓包 body 大小限制（默认 1MB） */
    this._maxBodySize = options.maxBodySize || 1024 * 1024;
    /** 抓包最大保留条数（默认 5000，超出 LRU 淘汰） */
    this._maxRequests = options.maxRequests || 5000;
  }

  /**
   * 启动 CDP 拦截
   * @param {WebContents} webContents
   */
  start(webContents) {
    if (!webContents) {
      logger.warn('CDP start 失败：webContents 为空');
      return;
    }
    if (webContents.debugger.isAttached()) {
      logger.warn('CDP 已连接，跳过重复 attach');
      return;
    }

    try {
      webContents.debugger.attach('1.3');
    } catch (e) {
      logger.error(`CDP attach 失败: ${e.message}`);
      return;
    }

    this._webContents = webContents;
    this._messageHandler = (event, method, params) => {
      // 全量抓包：监听所有网络事件
      if (this._captureEnabled) {
        if (method === 'Network.requestWillBeSent') {
          this._onRequestWillBeSent(params);
        } else if (method === 'Network.responseReceived') {
          this._onResponseReceived(params);
        } else if (method === 'Network.loadingFinished') {
          this._onLoadingFinished(params);
        } else if (method === 'Network.loadingFailed') {
          this._onLoadingFailed(params);
        } else if (method === 'Network.dataReceived') {
          this._onDataReceived(params);
        }
      }
      // 业务逻辑：评论/视频/搜索 - 在 loadingFinished 后处理（body 才可用）
      if (method === 'Network.loadingFinished') {
        this._handleLoadingFinished(webContents, params);
      }
    };
    this._detachHandler = (event, reason) => {
      logger.warn(`CDP 意外断开: ${reason}`);
      this._cleanup();
    };

    webContents.debugger.on('message', this._messageHandler);
    webContents.debugger.on('detach', this._detachHandler);

    webContents.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: 10 * 1024 * 1024,
      maxResourceBufferSize: 5 * 1024 * 1024
    });
    logger.info('CDP 拦截器已启动（含全量网络抓包）');
  }

  // ===== 新增：全量网络抓包方法 =====

  /**
   * 启用 / 禁用全量抓包
   */
  setCaptureEnabled(enabled) {
    this._captureEnabled = !!enabled;
    logger.info(`全量抓包已${this._captureEnabled ? '启用' : '禁用'}`);
  }

  /**
   * 请求发出 - 记录请求基础信息
   */
  _onRequestWillBeSent(params) {
    const { requestId, request, timestamp, type, frameId, initiator } = params;
    const url = request.url;

    // 跳过一些干扰（CSS/字体/图片等可按需关闭）
    if (type === 'Image' || type === 'Font' || type === 'Stylesheet') return;

    const req = {
      requestId,
      method: request.method,
      url,
      type,
      ts: Date.now(),
      cdpTs: timestamp,
      hasPostData: !!request.postData,
      postData: request.postData ? request.postData.substring(0, this._maxBodySize) : null,
      initiator: initiator ? initiator.type : null,
      response: null,
      parsed: null,
      failed: false
    };

    this._requestMap.set(requestId, req);
    this._addToLog(req);
  }

  /**
   * 响应到达 - 仅记录元数据，不获取 body
   * body 在 loadingFinished 后才可用
   */
  _onResponseReceived(params) {
    if (!this._webContents) return;
    const { requestId, response } = params;
    const req = this._requestMap.get(requestId);
    if (!req) return;

    req.response = {
      status: response.status,
      statusText: response.statusText,
      type: response.type,
      url: response.url,
      headers: response.headers,
      remoteIP: response.remoteIPAddress,
      remotePort: response.remotePort,
      fromDiskCache: response.fromDiskCache,
      fromServiceWorker: response.fromServiceWorker,
      body: null,
      bodyTruncated: false,
      bodyType: null,
      bodySize: 0
    };

    // 统计
    this._stats.total++;
    const statusClass = `${Math.floor(response.status / 100)}xx`;
    this._stats.byStatus[statusClass] = (this._stats.byStatus[statusClass] || 0) + 1;
    try {
      const host = new URL(response.url).host;
      this._stats.byDomain[host] = (this._stats.byDomain[host] || 0) + 1;
    } catch (_) {}
    this._stats.byMethod[req.method] = (this._stats.byMethod[req.method] || 0) + 1;
  }

  /**
   * 加载完成 - 此时 body 可用，异步获取
   */
  _onLoadingFinished(params) {
    if (!this._webContents) return;
    const { requestId } = params;
    const req = this._requestMap.get(requestId);
    if (!req || !req.response) return;

    // 跳过非文本类型
    if (req.type === 'Image' || req.type === 'Font' || req.type === 'Stylesheet' || req.type === 'Media') return;

    // 异步获取 body
    this._webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
      .then(({ body, base64Encoded }) => {
        if (!body) return;
        if (body.length > this._maxBodySize) {
          req.response.bodyTruncated = true;
          req.response.body = body.substring(0, this._maxBodySize);
        } else {
          req.response.body = body;
        }
        req.response.bodySize = body.length;
        if (base64Encoded) {
          req.response.bodyType = 'base64';
        } else {
          req.response.bodyType = 'text';
          try {
            req.parsed = JSON.parse(body);
            if (req.parsed && req.parsed.comments) {
              req.parsed.commentCount = req.parsed.comments.length;
            } else if (req.parsed && req.parsed.data && Array.isArray(req.parsed.data)) {
              req.parsed.dataCount = req.parsed.data.length;
            }
          } catch (_) {}
        }
      })
      .catch(() => {});
  }

  /**
   * 数据接收（仅记录大请求）
   */
  _onDataReceived(params) {
    // 占位 - 暂不处理分片 body
  }

  /**
   * 加载失败
   */
  _onLoadingFailed(params) {
    const req = this._requestMap.get(params.requestId);
    if (!req) return;
    req.failed = true;
    req.failure = {
      errorText: params.errorText,
      canceled: params.canceled,
      blockedReason: params.blockedReason,
      ts: Date.now()
    };
  }

  /**
   * 添加到日志（含 LRU 淘汰）
   */
  _addToLog(req) {
    this.allRequests.push(req);
    while (this.allRequests.length > this._maxRequests) {
      this.allRequests.shift();
    }
  }

  /**
   * 获取全部请求（返回副本）
   */
  getAllRequests() {
    return this.allRequests.slice();
  }

  /**
   * 获取最近 N 条请求
   */
  getRecentRequests(n) {
    n = n || 50;
    return this.allRequests.slice(-n);
  }

  /**
   * 获取最后一次的请求摘要（用于快速查看最近发生了什么）
   */
  getLastSummary() {
    if (this.allRequests.length === 0) return { count: 0 };
    const recent = this.allRequests.slice(-10);
    return {
      count: this.allRequests.length,
      stats: this._stats,
      recent: recent.map(r => ({
        ts: r.ts,
        method: r.method,
        url: r.url,
        status: r.response ? r.response.status : null,
        type: r.type,
        failed: r.failed,
        bodySize: r.response ? r.response.bodySize : 0,
        commentCount: r.parsed ? r.parsed.commentCount : null
      }))
    };
  }

  /**
   * 清空请求日志
   */
  clearRequests() {
    const count = this.allRequests.length;
    this.allRequests = [];
    this._requestMap.clear();
    this._stats = { total: 0, byDomain: {}, byMethod: {}, byStatus: {} };
    return count;
  }

  /**
   * 导出所有请求到 NDJSON 文件
   */
  exportToFile(filePath) {
    const fs = require('fs');
    const path = require('path');
    try {
      // 简化版（不含 body，避免内存爆）
      const lines = this.allRequests.map(r => JSON.stringify({
        ts: r.ts,
        method: r.method,
        url: r.url,
        type: r.type,
        status: r.response ? r.response.status : null,
        bodySize: r.response ? r.response.bodySize : 0,
        failed: r.failed,
        postData: r.postData
      }));
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
      return { ok: true, count: lines.length, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 开始采集某个视频的评论（videoProcessor 流程钩子）
   * 清理上一次的 currentVideo，强制只接受目标视频的 video 响应
   */
  beginCollect(awemeId) {
    logger.info(`[CDP] beginCollect: aid=${awemeId}, instance=${this._instanceId}, totalAids=${Object.keys(this.comments).length}`);
    this.collectTarget = awemeId;
    this.currentVideo = null;
    if (awemeId) {
      this._touchKey(awemeId);
    }
  }

  /**
   * 结束采集（videoProcessor 流程钩子）
   */
  endCollect(awemeId) {
    if (this.collectTarget === awemeId) {
      this.collectTarget = null;
    }
  }

  _touchKey(awemeId) {
    const idx = this.commentKeys.indexOf(awemeId);
    if (idx >= 0) this.commentKeys.splice(idx, 1);
    this.commentKeys.push(awemeId);
    // LRU 淘汰
    while (this.commentKeys.length > MAX_CACHED_VIDEOS) {
      const old = this.commentKeys.shift();
      delete this.comments[old];
    }
  }

  /**
   * 加载完成 - 业务逻辑处理（评论/视频/搜索）
   * 在 loadingFinished 后调用，此时 body 才可用
   */
  async _handleLoadingFinished(webContents, params) {
    const { requestId } = params;
    const req = this._requestMap.get(requestId);
    if (!req || !req.response) return;

    const url = req.url;
    const isComment = COMMENT_API_PATTERNS.some(p => url.includes(p));
    const isVideo = VIDEO_API_PATTERNS.some(p => url.includes(p));
    const isSearch = SEARCH_API_PATTERNS.some(p => url.includes(p));

    if (!isComment && !isVideo && !isSearch) return;

    if (this.processedIds.has(requestId)) return;
    this.processedIds.add(requestId);

    if (this.processedIds.size > 5000) {
      const arr = Array.from(this.processedIds);
      this.processedIds = new Set(arr.slice(-2000));
    }

    // 获取 body
    let text = null;
    if (req.response.body && req.response.bodyType !== 'base64') {
      text = req.response.body;
    }

    if (!text) {
      try {
        const { body, base64Encoded } = await webContents.debugger.sendCommand(
          'Network.getResponseBody', { requestId }
        );
        if (!body) return;
        text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
      } catch (e) {
        logger.warn(`[CDP] getResponseBody失败(loadingFinished): ${e.message}, url=${url.substring(0, 80)}`);
        return;
      }
    }

    if (isComment) {
      logger.info(`[CDP] 评论API拦截: url=${url.substring(0, 80)}, bodyLen=${text ? text.length : 0}`);
    }

    try {
      const data = JSON.parse(text);
      if (isComment) this._parseCommentResponse(url, data);
      if (isVideo) this._parseVideoResponse(data);
      if (isSearch) this._parseSearchResponse(data);
    } catch (e) {
      logger.warn(`[CDP] 业务解析失败(loadingFinished): ${e.message}, url=${url.substring(0, 80)}`);
    }
  }

  /**
   * 响应到达时的业务处理（已移到 _handleLoadingFinished）
   * 保留此方法以防向后兼容，但不再主动调用
   */
  async _handleResponseReceived(webContents, params) {
    const { requestId, response } = params;
    const url = response.url;

    if (this.processedIds.has(requestId)) return;
    this.processedIds.add(requestId);

    if (this.processedIds.size > 5000) {
      const arr = Array.from(this.processedIds);
      this.processedIds = new Set(arr.slice(-2000));
    }

    const isComment = COMMENT_API_PATTERNS.some(p => url.includes(p));
    const isVideo = VIDEO_API_PATTERNS.some(p => url.includes(p));
    const isSearch = SEARCH_API_PATTERNS.some(p => url.includes(p));

    if (!isComment && !isVideo && !isSearch) return;

    // 优先从全量抓包缓存中取 body（避免重复 getResponseBody）
    const cached = this._requestMap.get(requestId);
    let text = null;
    if (cached && cached.response && cached.response.body && !cached.response.base64Encoded) {
      text = cached.response.body;
    }

    if (!text) {
      try {
        const { body, base64Encoded } = await webContents.debugger.sendCommand(
          'Network.getResponseBody', { requestId }
        );
        if (!body) return;
        text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
      } catch (e) {
        return; // CDP 请求可能已过期
      }
    }

    try {
      const data = JSON.parse(text);
      if (isComment) this._parseCommentResponse(url, data);
      if (isVideo) this._parseVideoResponse(data);
      if (isSearch) this._parseSearchResponse(data);
    } catch (e) {
      // JSON 解析失败，静默忽略
    }
  }

  _parseCommentResponse(url, data) {
    let aid = '';
    try {
      const u = new URL(url);
      aid = u.searchParams.get('aweme_id') || '';
    } catch (e) {
      logger.warn(`[CDP] 评论URL解析失败: ${e.message}, url=${url.substring(0, 100)}`);
    }

    if (!aid) {
      logger.warn(`[CDP] 评论API无aweme_id: url=${url.substring(0, 100)}`);
      return;
    }

    // ★ 修正aid：如果collectTarget已设置且和URL中的aid不同，用collectTarget覆盖
    // 避免评论被归到错误的视频下（抖音评论API URL中的aweme_id可能是上一个视频的）
    if (this.collectTarget && this.collectTarget !== aid) {
      logger.info(`[CDP] 评论aid修正: ${aid} -> ${this.collectTarget} (collectTarget)`);
      aid = this.collectTarget;
    }

    logger.info(`[CDP] 评论解析开始: aid=${aid}, hasComments=${!!data.comments}, hasData=${!!data.data}, topKeys=${Object.keys(data).slice(0, 5).join(',')}`);
    if (url.includes('/comment/publish')) {
      const statusCode = data.status_code || data.status;
      if (statusCode === 0) {
        logger.info('评论发布成功');
        this.lastPublishResult = { success: true, timestamp: Date.now() };
      } else {
        logger.warn(`评论发布失败: status_code=${statusCode}`);
        this.lastPublishResult = { success: false, statusCode, timestamp: Date.now() };
      }
      return;
    }

    let commentsData = [];
    if (data.comments) {
      commentsData = data.comments;
    } else if (data.data && data.data.comments) {
      commentsData = data.data.comments;
    } else {
      for (const key of Object.keys(data)) {
        if (data[key] && data[key].comments) {
          commentsData = data[key].comments;
          break;
        }
      }
    }

    if (commentsData.length === 0) {
      // 尝试从 status_code 判断
      const sc = data.status_code || data.status;
      logger.info(`[CDP] 评论数据为空: aid=${aid}, status_code=${sc}, keys=${Object.keys(data).join(',')}`);
      return;
    }

    let videoDesc = '';
    let videoAuthor = '';
    if (data.aweme_info) {
      videoDesc = data.aweme_info.desc || '';
      videoAuthor = data.aweme_info.author?.nickname || '';
    }

    this._touchKey(aid);
    if (!this.comments[aid]) this.comments[aid] = [];

    for (const c of commentsData) {
      if (!c || typeof c !== 'object') continue;

      const user = c.user || {};
      const uid = String(user.uid || '');
      const secUid = user.sec_uid || '';
      const shortId = String(user.short_id || '');
      const uniqueId = String(user.unique_id || '');
      const douyinId = uniqueId || shortId || uid;

      // 毫秒检测：抖音API有时返回毫秒级时间戳
      let ct = c.create_time || 0;
      if (ct > 10000000000) ct = Math.floor(ct / 1000);

      const comment = {
        comment_id: String(c.cid || ''),
        text: c.text || '',
        create_time: ct,
        uid,
        sec_uid: secUid,
        douyin_id: douyinId,
        nickname: user.nickname || '',
        ip_label: c.ip_label || '',
        profile_url: secUid ? `https://www.douyin.com/user/${secUid}` : '',
        signature: user.signature || '',
        avatar: user.avatar_thumb?.url_list?.[0] || '',
        aweme_id: aid,
        video_desc: videoDesc,
        video_author: videoAuthor,
        video_url: `https://www.douyin.com/video/${aid}`,
        digg_count: c.digg_count || 0,
        reply_comment_total: c.reply_comment_total || 0,
        source: 'cdp'
      };

      if (!this.comments[aid].some(c2 => c2.comment_id === comment.comment_id)) {
        this.comments[aid].push(comment);
        // 同步写入全局缓存
        _globalTouchKey(aid);
        if (!_globalComments[aid]) _globalComments[aid] = [];
        if (!_globalComments[aid].some(c2 => c2.comment_id === comment.comment_id)) {
          _globalComments[aid].push({...comment});
        }
        if (this.onComment) this.onComment(comment);
      }
    }
    logger.info(`[CDP] 评论解析完成: aid=${aid}, count=${this.comments[aid].length}, parsed=${commentsData.length}, instance=${this._instanceId}, totalAids=${Object.keys(this.comments).length}`);
  }

  _parseVideoResponse(data) {
    try {
      // 视频详情 API
      const aweme = data.aweme_detail || (data.data && data.data.aweme_detail);
      if (aweme && aweme.aweme_id) {
        if (this.collectTarget && this.collectTarget !== aweme.aweme_id) return;
        this.currentVideo = {
          aweme_id: aweme.aweme_id,
          desc: aweme.desc || '',
          author: aweme.author?.nickname || '',
          author_uid: aweme.author?.uid || '',
          author_sec_uid: aweme.author?.sec_uid || '',
          create_time: aweme.create_time || 0,
          video_url: `https://www.douyin.com/video/${aweme.aweme_id}`
        };
        if (this.onVideo) this.onVideo(this.currentVideo);
      }

      // Feed 列表 API（首页推荐）
      const feedList = data.aweme_list || [];
      if (Array.isArray(feedList) && feedList.length > 0) {
        for (const item of feedList) {
          if (item.aweme_id) {
            this.feedCache.set(item.aweme_id, {
              aweme_id: item.aweme_id,
              desc: item.desc || '',
              author: item.author?.nickname || '',
              create_time: item.create_time || 0,
              share_url: item.share_url || ''
            });
          }
        }
        // LRU 淘汰：超过 500 个时删除最早的
        while (this.feedCache.size > 500) {
          const firstKey = this.feedCache.keys().next().value;
          if (firstKey !== undefined) this.feedCache.delete(firstKey);
          else break;
        }
        logger.info(`Feed 缓存更新，共 ${this.feedCache.size} 个视频`);
      }
    } catch (e) {}
  }

  _parseSearchResponse(data) {
    try {
      const items = (data.data && data.data.data) || data.data || [];
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const aw = item.aweme_info || item;
        if (aw && aw.aweme_id) {
          this.searchVideos.push({
            aweme_id: aw.aweme_id,
            desc: aw.desc || '',
            author: aw.author?.nickname || '',
            create_time: aw.create_time || 0
          });
        }
      }
      // 搜索结果上限：超过 200 条时从头部删除
      while (this.searchVideos.length > 200) {
        this.searchVideos.shift();
      }
    } catch (e) {}
  }

  getComments(awemeId) {
    if (awemeId) {
      this._touchKey(awemeId);
      let result = (this.comments[awemeId] || []).slice();
      // 如果实例缓存为空，尝试全局缓存兜底
      if (result.length === 0) {
        const globalResult = getGlobalComments(awemeId);
        if (globalResult.length > 0) {
          logger.info(`[CDP] getComments从全局缓存恢复: aid=${awemeId}, count=${globalResult.length}, instance=${this._instanceId}`);
          // 回填实例缓存
          this.comments[awemeId] = globalResult.map(c => ({...c}));
          result = globalResult;
        }
      }
      if (result.length === 0) {
        const keys = Object.keys(this.comments);
        logger.info(`[CDP] getComments空: aid=${awemeId}, instance=${this._instanceId}, totalAids=${keys.length}, existingKeys=${keys.slice(0, 5).join(',')}`);
      } else {
        logger.info(`[CDP] getComments命中: aid=${awemeId}, count=${result.length}, instance=${this._instanceId}`);
      }
      return result;
    }
    return [];
  }

  getSearchVideos() {
    const videos = [...this.searchVideos];
    this.searchVideos = [];
    return videos;
  }

  /**
   * 获取 Feed 缓存中的视频
   */
  getFeedVideo(aid) {
    return this.feedCache.get(aid) || null;
  }

  /**
   * 等待评论发布结果
   */
  async waitForPublishResult(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.lastPublishResult && (Date.now() - this.lastPublishResult.timestamp) < 2000) {
        const result = this.lastPublishResult;
        this.lastPublishResult = null;
        return result;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return { success: false, reason: 'timeout' };
  }

  clearComments(awemeId) {
    if (awemeId) {
      delete this.comments[awemeId];
      const idx = this.commentKeys.indexOf(awemeId);
      if (idx >= 0) this.commentKeys.splice(idx, 1);
    } else {
      this.comments = {};
      this.commentKeys = [];
    }
  }

  /**
   * 停止拦截
   * @param {WebContents} webContents
   */
  stop(webContents) {
    const wc = webContents || this._webContents;
    try {
      if (wc && !wc.isDestroyed && wc.isDestroyed()) return;
      if (wc && wc.debugger && wc.debugger.isAttached()) {
        wc.debugger.sendCommand('Network.disable', {}).catch(() => {});
        wc.debugger.detach();
      }
    } catch (e) {
      logger.warn(`CDP 停止异常: ${e.message}`);
    }
    this._cleanup();
    logger.info('CDP 拦截器已停止');
  }

  _cleanup() {
    // 注意：不清空 this.comments 和 this.commentKeys，因为CDP重连时评论数据仍有效
    this.searchVideos = [];
    this.processedIds = new Set();
    this.allRequests = [];
    this._requestMap.clear();
    this._stats = { total: 0, byDomain: {}, byMethod: {}, byStatus: {} };
    if (this._webContents) {
      try {
        if (this._messageHandler) this._webContents.debugger.off('message', this._messageHandler);
        if (this._detachHandler) this._webContents.debugger.off('detach', this._detachHandler);
      } catch (e) {}
    }
    this._webContents = null;
    this._messageHandler = null;
    this._detachHandler = null;
  }
}

// ===== 全局评论缓存（跨实例兜底） =====
// 即使 CDPInterceptor 实例被重建，评论数据仍可从这里找回
const _globalComments = {};
const _globalCommentKeys = [];
const MAX_GLOBAL_VIDEOS = 200;

function _globalTouchKey(awemeId) {
  const idx = _globalCommentKeys.indexOf(awemeId);
  if (idx >= 0) _globalCommentKeys.splice(idx, 1);
  _globalCommentKeys.push(awemeId);
  while (_globalCommentKeys.length > MAX_GLOBAL_VIDEOS) {
    const old = _globalCommentKeys.shift();
    delete _globalComments[old];
  }
}

function getGlobalComments(awemeId) {
  return _globalComments[awemeId] ? _globalComments[awemeId].slice() : [];
}

function clearGlobalComments() {
  Object.keys(_globalComments).forEach(k => delete _globalComments[k]);
  _globalCommentKeys.length = 0;
}

module.exports = CDPInterceptor;
module.exports.getGlobalComments = getGlobalComments;
module.exports.clearGlobalComments = clearGlobalComments;
