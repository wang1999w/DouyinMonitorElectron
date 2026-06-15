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
  constructor() {
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
      if (method === 'Network.responseReceived') {
        this._handleResponseReceived(webContents, params);
      }
    };
    this._detachHandler = (event, reason) => {
      logger.warn(`CDP 意外断开: ${reason}`);
      this._cleanup();
    };

    webContents.debugger.on('message', this._messageHandler);
    webContents.debugger.on('detach', this._detachHandler);

    webContents.debugger.sendCommand('Network.enable', {});
    logger.info('CDP 拦截器已启动');
  }

  /**
   * 开始采集某个视频的评论（videoProcessor 流程钩子）
   * 清理上一次的 currentVideo，强制只接受目标视频的 video 响应
   */
  beginCollect(awemeId) {
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

  async _handleResponseReceived(webContents, params) {
    const { requestId, response } = params;
    const url = response.url;

    if (this.processedIds.has(requestId)) return;
    this.processedIds.add(requestId);

    if (this.processedIds.size > 5000) {
      const arr = Array.from(this.processedIds);
      this.processedIds = new Set(arr.slice(-2000));
    }

    try {
      const isComment = COMMENT_API_PATTERNS.some(p => url.includes(p));
      const isVideo = VIDEO_API_PATTERNS.some(p => url.includes(p));
      const isSearch = SEARCH_API_PATTERNS.some(p => url.includes(p));

      if (!isComment && !isVideo && !isSearch) return;

      const { body, base64Encoded } = await webContents.debugger.sendCommand(
        'Network.getResponseBody', { requestId }
      );
      if (!body) return;

      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
      const data = JSON.parse(text);

      if (isComment) this._parseCommentResponse(url, data);
      if (isVideo) this._parseVideoResponse(data);
      if (isSearch) this._parseSearchResponse(data);
    } catch (e) {
      // CDP 请求可能已过期，静默忽略
    }
  }

  _parseCommentResponse(url, data) {
    let aid = '';
    try {
      const u = new URL(url);
      aid = u.searchParams.get('aweme_id') || '';
    } catch (e) {}

    // 评论发布 API
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

    if (!aid && commentsData.length > 0) {
      for (const c of commentsData) {
        if (c.aweme_id) { aid = c.aweme_id; break; }
      }
    }

    if (!aid || commentsData.length === 0) return;

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

      const comment = {
        comment_id: String(c.cid || ''),
        text: c.text || '',
        create_time: c.create_time || 0,
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
        if (this.onComment) this.onComment(comment);
      }
    }
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
    } catch (e) {}
  }

  getComments(awemeId) {
    if (awemeId) {
      this._touchKey(awemeId);
      return (this.comments[awemeId] || []).slice();
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
    this.comments = {};
    this.commentKeys = [];
    this.searchVideos = [];
    this.currentVideo = null;
    this.collectTarget = null;
    this.processedIds = new Set();
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

module.exports = CDPInterceptor;
