/**
 * 小红书 CDP 网络响应拦截器
 *
 * 通过 Chrome DevTools Protocol 拦截小红书 API 响应体
 * 提取评论/笔记/搜索 API 的 JSON 数据
 *
 * 拦截的 API：
 *   - /api/sns/web/v2/comment/page     评论列表
 *   - /api/sns/web/v2/comment/sub/page  子评论
 *   - /api/sns/web/v1/feed             笔记详情
 *   - /api/sns/web/v1/user_posted       用户笔记列表
 *   - /api/sns/web/v1/search/notes      搜索笔记
 *   - /api/sns/web/v1/user/otherinfo    用户信息
 */

const { getLogger } = require('./logger');
const logger = getLogger('XHS-CDP');

// 小红书 API 模式
const COMMENT_API_PATTERNS = [
  '/api/sns/web/v2/comment/page',
  '/api/sns/web/v2/comment/sub/page'
];

const NOTE_API_PATTERNS = [
  '/api/sns/web/v1/feed',
  '/api/sns/web/v1/user_posted'
];

const SEARCH_API_PATTERNS = [
  '/api/sns/web/v1/search/notes'
];

const USER_API_PATTERNS = [
  '/api/sns/web/v1/user/otherinfo'
];

// 评论缓存最大保留笔记数（LRU 淘汰）
const MAX_CACHED_NOTES = 200;

class XHSCDPInterceptor {
  constructor(options = {}) {
    /** note_id -> 评论列表 */
    this.comments = {};
    /** 评论访问顺序（LRU） */
    this.commentKeys = [];
    /** 搜索结果中的笔记信息 */
    this.searchNotes = [];
    /** 当前正在查看的笔记信息 */
    this.currentNote = null;
    /** 采集目标 note_id */
    this.collectTarget = null;
    /** 已处理的请求 ID */
    this.processedIds = new Set();
    /** 回调 */
    this.onComment = null;
    this.onNote = null;
    /** 网络请求推送回调（用于渲染进程 Network 面板） */
    this.onRequest = null;
    /** 用户缓存 */
    this.userCache = new Map();
    /** debugger 句柄 */
    this._webContents = null;
    this._messageHandler = null;
    this._detachHandler = null;
    // ===== 全量网络抓包 =====
    this.allRequests = [];
    this._requestMap = new Map();
    this._stats = { total: 0, byDomain: {}, byMethod: {}, byStatus: {} };
    this._captureEnabled = options.captureEnabled !== false;
    this._maxBodySize = options.maxBodySize || 1024 * 1024;
    this._maxRequests = options.maxRequests || 5000;
  }

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
      if (this._captureEnabled) {
        if (method === 'Network.requestWillBeSent') this._onRequestWillBeSent(params);
        else if (method === 'Network.responseReceived') this._onResponseReceived(params);
        else if (method === 'Network.loadingFinished') this._onLoadingFinished(params);
        else if (method === 'Network.loadingFailed') this._onLoadingFailed(params);
      }
      if (method === 'Network.loadingFinished') {
        this._handleLoadingFinished(webContents, params);
      }
    };
    this._detachHandler = (event, reason) => {
      logger.warn(`CDP 意外断开: ${reason}`);
      // 只清理debugger相关资源，保留评论缓存
      this.processedIds = new Set();
      this._requestMap.clear();
      if (this._webContents) {
        try {
          if (this._messageHandler) this._webContents.debugger.off('message', this._messageHandler);
          if (this._detachHandler) this._webContents.debugger.off('detach', this._detachHandler);
        } catch (e) {}
      }
      this._webContents = null;
      this._messageHandler = null;
      this._detachHandler = null;
      // 不清除评论缓存，重连后可继续使用
    };

    webContents.debugger.on('message', this._messageHandler);
    webContents.debugger.on('detach', this._detachHandler);

    webContents.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: 10 * 1024 * 1024,
      maxResourceBufferSize: 5 * 1024 * 1024
    });
    logger.info('小红书 CDP 拦截器已启动');
  }

  // ===== 全量抓包方法（与抖音版一致） =====

  setCaptureEnabled(enabled) {
    this._captureEnabled = !!enabled;
  }

  _onRequestWillBeSent(params) {
    const { requestId, request, timestamp, type } = params;
    if (type === 'Image' || type === 'Font' || type === 'Stylesheet') return;
    const req = {
      requestId, method: request.method, url: request.url, type,
      ts: Date.now(), cdpTs: timestamp,
      hasPostData: !!request.postData,
      postData: request.postData ? request.postData.substring(0, this._maxBodySize) : null,
      response: null, parsed: null, failed: false
    };
    this._requestMap.set(requestId, req);
    this._addToLog(req);
  }

  _onResponseReceived(params) {
    if (!this._webContents) return;
    const { requestId, response } = params;
    const req = this._requestMap.get(requestId);
    if (!req) return;
    req.response = {
      status: response.status, statusText: response.statusText,
      type: response.type, url: response.url,
      headers: response.headers, remoteIP: response.remoteIPAddress,
      body: null, bodyTruncated: false, bodyType: null, bodySize: 0
    };
    this._stats.total++;
    const statusClass = `${Math.floor(response.status / 100)}xx`;
    this._stats.byStatus[statusClass] = (this._stats.byStatus[statusClass] || 0) + 1;
    try {
      const host = new URL(response.url).host;
      this._stats.byDomain[host] = (this._stats.byDomain[host] || 0) + 1;
    } catch (_) {}
    this._stats.byMethod[req.method] = (this._stats.byMethod[req.method] || 0) + 1;

    // 推送到渲染进程 Network 面板
    if (this.onRequest) {
      this.onRequest({
        id: Date.now() + Math.random(),
        url: response.url,
        method: req.method,
        statusCode: response.status,
        timestamp: new Date().toLocaleTimeString(),
        type: response.type || req.type
      });
    }
  }

  _onLoadingFinished(params) {
    if (!this._webContents) return;
    const { requestId } = params;
    const req = this._requestMap.get(requestId);
    if (!req || !req.response) return;
    if (req.type === 'Image' || req.type === 'Font' || req.type === 'Stylesheet' || req.type === 'Media') return;
    this._webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
      .then(({ body, base64Encoded }) => {
        if (!body) return;
        req.response.body = body.length > this._maxBodySize ? body.substring(0, this._maxBodySize) : body;
        req.response.bodySize = body.length;
        req.response.bodyType = base64Encoded ? 'base64' : 'text';
        if (!base64Encoded) {
          try { req.parsed = JSON.parse(body); } catch (_) {}
        }
      }).catch(() => {});
  }

  _onLoadingFailed(params) {
    const req = this._requestMap.get(params.requestId);
    if (!req) return;
    req.failed = true;
  }

  _addToLog(req) {
    this.allRequests.push(req);
    while (this.allRequests.length > this._maxRequests) this.allRequests.shift();
  }

  getAllRequests() { return this.allRequests.slice(); }
  getRecentRequests(n) { return this.allRequests.slice(-(n || 50)); }

  clearRequests() {
    const count = this.allRequests.length;
    this.allRequests = [];
    this._requestMap.clear();
    this._stats = { total: 0, byDomain: {}, byMethod: {}, byStatus: {} };
    return count;
  }

  // ===== 业务逻辑 =====

  beginCollect(noteId) {
    this.collectTarget = noteId;
    this.currentNote = null;
    if (noteId) this._touchKey(noteId);
  }

  endCollect(noteId) {
    if (this.collectTarget === noteId) this.collectTarget = null;
  }

  _touchKey(noteId) {
    const idx = this.commentKeys.indexOf(noteId);
    if (idx >= 0) this.commentKeys.splice(idx, 1);
    this.commentKeys.push(noteId);
    while (this.commentKeys.length > MAX_CACHED_NOTES) {
      const old = this.commentKeys.shift();
      delete this.comments[old];
    }
  }

  async _handleLoadingFinished(webContents, params) {
    const { requestId } = params;
    const req = this._requestMap.get(requestId);
    if (!req || !req.response) return;

    const url = req.url;
    const isComment = COMMENT_API_PATTERNS.some(p => url.includes(p));
    const isNote = NOTE_API_PATTERNS.some(p => url.includes(p));
    const isSearch = SEARCH_API_PATTERNS.some(p => url.includes(p));
    const isUser = USER_API_PATTERNS.some(p => url.includes(p));

    if (!isComment && !isNote && !isSearch && !isUser) return;
    if (this.processedIds.has(requestId)) return;
    this.processedIds.add(requestId);

    if (this.processedIds.size > 5000) {
      const arr = Array.from(this.processedIds);
      this.processedIds = new Set(arr.slice(-2000));
    }

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
        logger.warn(`getResponseBody失败: ${e.message}, url=${url.substring(0, 80)}`);
        return;
      }
    }

    try {
      const data = JSON.parse(text);
      if (isComment) this._parseCommentResponse(url, data);
      if (isNote) this._parseNoteResponse(data);
      if (isSearch) this._parseSearchResponse(data);
      if (isUser) this._parseUserResponse(data);
    } catch (e) {
      logger.warn(`业务解析失败: ${e.message}, url=${url.substring(0, 80)}`);
    }
  }

  _parseCommentResponse(url, data) {
    // 从 URL 提取 note_id
    let noteId = '';
    try {
      const u = new URL(url);
      noteId = u.searchParams.get('note_id') || '';
    } catch (e) {}

    if (!noteId) {
      // 尝试从响应体中获取
      const items = data?.data?.items || [];
      if (items.length > 0 && items[0]?.note_card?.note_id) {
        noteId = items[0].note_card.note_id;
      }
    }

    if (!noteId) {
      logger.warn(`评论API无note_id: url=${url.substring(0, 100)}`);
      return;
    }

    logger.info(`[CDP] 评论API拦截: noteId=${noteId}, url=${url.substring(0, 80)}`);

    // 解析评论列表
    const commentsData = data?.data?.comments || [];
    if (commentsData.length === 0) {
      logger.info(`[CDP] 评论数据为空: noteId=${noteId}`);
      return;
    }

    this._touchKey(noteId);
    if (!this.comments[noteId]) this.comments[noteId] = [];

    // 笔记信息
    const noteCard = data?.data?.note_card || {};
    const noteTitle = noteCard.title || '';
    const noteAuthor = noteCard.user?.nickname || '';

    for (const c of commentsData) {
      if (!c || typeof c !== 'object') continue;

      const userInfo = c.user_info || {};
      const userId = String(userInfo.user_id || userInfo.userid || '');
      const comment = {
        comment_id: String(c.id || ''),
        text: c.content || '',
        create_time: c.create_time > 10000000000 ? Math.floor(c.create_time / 1000) : (c.create_time || 0),
        uid: userId,
        nickname: userInfo.nickname || '',
        ip_label: c.ip_location || '',
        profile_url: userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : '',
        avatar: userInfo.image || '',
        note_id: noteId,
        note_title: noteTitle,
        note_author: noteAuthor,
        note_url: `https://www.xiaohongshu.com/explore/${noteId}`,
        like_count: c.like_count || 0,
        reply_count: c.sub_comment_count || 0,
        source: 'cdp',
        platform: 'xhs'
      };

      if (!this.comments[noteId].some(c2 => c2.comment_id === comment.comment_id)) {
        this.comments[noteId].push(comment);
        if (this.onComment) this.onComment(comment);
      }
    }
    logger.info(`[CDP] 评论解析完成: noteId=${noteId}, count=${this.comments[noteId].length}`);
  }

  _parseNoteResponse(data) {
    try {
      // 笔记详情 API
      const items = data?.data?.items || [];
      for (const item of items) {
        const noteCard = item?.note_card || {};
        if (noteCard.note_id) {
          if (this.collectTarget && this.collectTarget !== noteCard.note_id) continue;
          this.currentNote = {
            note_id: noteCard.note_id,
            title: noteCard.title || noteCard.desc || '',
            desc: noteCard.desc || '',
            type: noteCard.type || 'normal',
            author: noteCard.user?.nickname || '',
            author_id: noteCard.user?.userid || '',
            note_url: `https://www.xiaohongshu.com/explore/${noteCard.note_id}`,
            interact_info: noteCard.interact_info || {},
            create_time: noteCard.time ? Math.floor(noteCard.time / 1000) : 0
          };
          if (this.onNote) this.onNote(this.currentNote);
        }
      }

      // 用户笔记列表 API
      const notes = data?.data?.notes || [];
      for (const note of notes) {
        if (note.note_id) {
          this.currentNote = {
            note_id: note.note_id,
            title: note.display_title || note.title || '',
            desc: '',
            type: note.type || 'normal',
            author: note.user?.nickname || '',
            author_id: note.user?.userid || '',
            note_url: `https://www.xiaohongshu.com/explore/${note.note_id}`,
            create_time: note.last_update_time ? Math.floor(note.last_update_time / 1000) : 0
          };
        }
      }
    } catch (e) {
      logger.warn(`笔记解析失败: ${e.message}`);
    }
  }

  _parseSearchResponse(data) {
    try {
      const items = data?.data?.items || [];
      for (const item of items) {
        const noteCard = item?.note_card || item;
        if (noteCard.note_id) {
          this.searchNotes.push({
            note_id: noteCard.note_id,
            title: noteCard.display_title || noteCard.title || noteCard.desc || '',
            author: noteCard.user?.nickname || '',
            type: noteCard.type || 'normal',
            create_time: noteCard.time ? Math.floor(noteCard.time / 1000) : 0
          });
        }
      }
      while (this.searchNotes.length > 200) this.searchNotes.shift();
    } catch (e) {}
  }

  _parseUserResponse(data) {
    try {
      const userInfo = data?.data?.user_info || {};
      if (userInfo.userid) {
        this.userCache.set(userInfo.userid, {
          userid: userInfo.userid,
          nickname: userInfo.nickname || '',
          desc: userInfo.desc || '',
          avatar: userInfo.image || ''
        });
        // LRU
        while (this.userCache.size > 500) {
          const firstKey = this.userCache.keys().next().value;
          this.userCache.delete(firstKey);
        }
      }
    } catch (e) {}
  }

  getComments(noteId) {
    if (noteId) {
      this._touchKey(noteId);
      return (this.comments[noteId] || []).slice();
    }
    return [];
  }

  getSearchNotes() {
    const notes = [...this.searchNotes];
    this.searchNotes = [];
    return notes;
  }

  clearComments(noteId) {
    if (noteId) {
      delete this.comments[noteId];
      const idx = this.commentKeys.indexOf(noteId);
      if (idx >= 0) this.commentKeys.splice(idx, 1);
    } else {
      this.comments = {};
      this.commentKeys = [];
    }
  }

  stop(webContents) {
    const wc = webContents || this._webContents;
    try {
      if (wc && !wc.isDestroyed?.()) {
        if (wc.debugger?.isAttached()) {
          wc.debugger.sendCommand('Network.disable', {}).catch(() => {});
          wc.debugger.detach();
        }
      }
    } catch (e) {
      logger.warn(`CDP 停止异常: ${e.message}`);
    }
    this._cleanup();
    logger.info('小红书 CDP 拦截器已停止');
  }

  _cleanup() {
    // 注意：不清除评论缓存和搜索笔记缓存，CDP重连后可继续使用
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

module.exports = XHSCDPInterceptor;
