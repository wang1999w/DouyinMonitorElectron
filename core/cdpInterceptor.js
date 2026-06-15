/**
 * CDP 网络响应拦截器
 * 通过 Chrome DevTools Protocol 拦截完整的 HTTP 响应体
 * 提取评论 API 的 JSON 数据，获取完整的用户信息
 *
 * 采集字段完整清单：
 * - comment_id   评论ID
 * - uid          用户ID
 * - nickname     用户名称
 * - text         评论内容
 * - ip_label     IP属地
 * - create_time  评论时间
 * - sec_uid      用户主页ID
 * - profile_url  用户主页链接
 * - aweme_id     视频ID
 * - author       博主名称
 * - desc         视频文案
 * - video_url    视频链接
 */

const { getLogger } = require('./logger');
const logger = getLogger('CDPInterceptor');

/** 抖音评论 API 路径特征 */
const COMMENT_API_PATTERNS = [
  '/comment/list',
  '/comment/list_reply'
];

/** 抖音视频信息 API 路径特征 */
const VIDEO_API_PATTERNS = [
  '/aweme/v1/web/aweme/detail',
  '/aweme/post'
];

/** 搜索结果 API 路径特征 */
const SEARCH_API_PATTERNS = [
  '/web/general/search/single',
  '/web/search/item'
];

class CDPInterceptor {
  constructor() {
    /** 按 aweme_id 存储的评论数据 */
    this.comments = {};
    /** 搜索结果中的视频信息 */
    this.searchVideos = [];
    /** 当前正在查看的视频信息 */
    this.currentVideo = null;
    /** 已拦截的请求 ID 集合（防重复处理） */
    this.processedIds = new Set();
    /** 回调 */
    this.onComment = null;
    this.onVideo = null;
  }

  /**
   * 启动 CDP 拦截
   * @param {WebContents} webContents - BrowserView 的 webContents
   */
  start(webContents) {
    if (!webContents) return;

    try {
      webContents.debugger.attach('1.3');
    } catch (e) {
      logger.error(`CDP attach 失败: ${e.message}`);
      return;
    }

    webContents.debugger.sendCommand('Network.enable', {});

    webContents.debugger.on('message', (event, method, params) => {
      if (method === 'Network.responseReceived') {
        this._handleResponseReceived(webContents, params);
      }
    });

    logger.info('CDP 拦截器已启动');
  }

  /**
   * 处理网络响应
   * 先匹配 URL，再获取响应体解析 JSON
   */
  async _handleResponseReceived(webContents, params) {
    const { requestId, response } = params;
    const url = response.url;

    if (this.processedIds.has(requestId)) return;
    this.processedIds.add(requestId);

    // 防止集合过大
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

      if (isComment) {
        this._parseCommentResponse(url, data);
      }
      if (isVideo) {
        this._parseVideoResponse(data);
      }
      if (isSearch) {
        this._parseSearchResponse(data);
      }
    } catch (e) {
      // CDP 请求可能已过期，静默忽略
    }
  }

  /**
   * 解析评论 API 响应
   * 提取完整评论数据：用户ID、昵称、评论内容、IP、时间、视频信息
   */
  _parseCommentResponse(url, data) {
    // 从 URL 提取 aweme_id
    let aid = '';
    try {
      const u = new URL(url);
      aid = u.searchParams.get('aweme_id') || '';
    } catch (e) {}

    // 从响应体多层结构中提取评论数组
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

    // 从评论中补充 aweme_id
    if (!aid && commentsData.length > 0) {
      for (const c of commentsData) {
        if (c.aweme_id) { aid = c.aweme_id; break; }
      }
    }

    if (!aid || commentsData.length === 0) return;

    // 提取视频信息（从响应中可能携带）
    let videoDesc = '';
    let videoAuthor = '';
    if (data.aweme_info) {
      videoDesc = data.aweme_info.desc || '';
      videoAuthor = data.aweme_info.author?.nickname || '';
    }

    if (!this.comments[aid]) {
      this.comments[aid] = [];
    }

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
        reply_comment_total: c.reply_comment_total || 0
      };

      // 去重
      if (!this.comments[aid].some(c2 => c2.comment_id === comment.comment_id)) {
        this.comments[aid].push(comment);
        if (this.onComment) this.onComment(comment);
      }
    }

    logger.info(`拦截评论: aweme_id=${aid}, 数量=${commentsData.length}, 累计=${this.comments[aid].length}`);
  }

  /**
   * 解析视频详情 API 响应
   */
  _parseVideoResponse(data) {
    try {
      const aweme = data.aweme_detail || (data.data && data.data.aweme_detail);
      if (!aweme || !aweme.aweme_id) return;

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
    } catch (e) {}
  }

  /**
   * 解析搜索结果 API 响应
   */
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

  /**
   * 获取指定视频的所有评论
   * @param {string} awemeId - 视频 ID
   * @returns {Array} 评论列表
   */
  getComments(awemeId) {
    return this.comments[awemeId] || [];
  }

  /**
   * 获取搜索到的视频列表
   */
  getSearchVideos() {
    const videos = [...this.searchVideos];
    this.searchVideos = [];
    return videos;
  }

  /**
   * 清空指定视频的评论缓存
   */
  clearComments(awemeId) {
    if (awemeId) {
      this.comments[awemeId] = [];
    } else {
      this.comments = {};
    }
  }

  /**
   * 停止拦截
   */
  stop(webContents) {
    try {
      if (webContents && webContents.debugger.isAttached()) {
        webContents.debugger.sendCommand('Network.disable', {}).catch(() => {});
        webContents.debugger.detach();
      }
    } catch (e) {
      logger.warn(`CDP 停止异常: ${e.message}`);
    }
    this.comments = {};
    this.searchVideos = [];
    logger.info('CDP 拦截器已停止');
  }
}

module.exports = CDPInterceptor;
