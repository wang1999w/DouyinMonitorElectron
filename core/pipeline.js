/**
 * 数据处理管道
 * 完整采集字段：
 *   用户ID / 用户名称 / 评论内容 / IP属地 / 评论时间
 *   视频文案 / 视频链接 / 博主名称
 * 双重采集：CDP API拦截（主）+ DOM采集（备）
 * 数据去重 + 关键词匹配 + 评分 + 入库 + 推送
 */

const { matchIntent, calcCommentScore, calcCommentScoreAdvanced } = require('./match');
const database = require('./database');
const notifier = require('./notifier');
const { getLogger } = require('./logger');

const logger = getLogger('DataPipeline');

/**
 * 处理一条评论（统一入口）
 * 自动合并 CDP 数据和 DOM 数据，补全缺失字段
 * @param {Object} cdpComment - CDP 拦截到的完整评论（可能为 null）
 * @param {Object} domComment - DOM 采集到的评论（可能为 null）
 * @param {Object} videoInfo - 视频信息 { aweme_id, desc, author, video_url }
 * @param {Object} keywords - { intent: [], garbage: [] }
 * @returns {Object|null} 处理后的完整评论数据，null 表示无效
 */
function processComment(cdpComment, domComment, videoInfo, keywords, options) {
  const merged = mergeCommentData(cdpComment, domComment);
  if (!merged || !merged.text || merged.text.length < 3) return null;
  if (isDuplicate(merged)) return null;

  // 毫秒检测：确保create_time是秒级时间戳
  if (merged.create_time > 10000000000) {
    merged.create_time = Math.floor(merged.create_time / 1000);
  }

  const [matched, matchedKeywords, isGarbage] = matchIntent(
    merged.text, keywords.intent || [], keywords.garbage || []
  );

  // 调试日志：记录匹配详情
  if (!matched && !isGarbage && merged.text.length >= 3) {
    logger.debug(`[未命中] "${merged.text.slice(0, 30)}" intent词数=${(keywords.intent || []).length}`);
  }

  if (!matched || isGarbage) return null;

  // ⚠️ 关键修复：优先使用动态评分函数，如果提供了 cutoffTs 和 commentHours
  let score;
  if (options && options.cutoffTs > 0 && options.commentHours > 0) {
    score = calcCommentScoreAdvanced(merged.create_time, options.cutoffTs, options.commentHours);
  } else {
    score = calcCommentScore(merged.create_time);
  }

  // ⚠️ 关键安全校验：如果评论的 aweme_id 与当前视频 aweme_id 不一致，说明数据错配，跳过
  if (merged.aweme_id && videoInfo.aweme_id && merged.aweme_id !== videoInfo.aweme_id) {
    logger.warn(`[Pipeline] aweme_id 不匹配: 评论=${merged.aweme_id} vs 视频=${videoInfo.aweme_id}，跳过该评论防错配`);
    return null;
  }

  // 构建完整数据（严格以 videoInfo 为视频信息来源，禁止从 merged 回退视频信息防止 A用户数据给B用户
  const isDouyin = !merged.note_id;
  const result = {
    comment_id: merged.comment_id || generateId(),
    uid: merged.uid || merged.douyin_id || '',
    nickname: merged.nickname || '未知',
    text: merged.text,
    ip_label: merged.ip_label || '未采集',
    create_time: merged.create_time || 0,
    profile_url: merged.profile_url || '',
    douyin_id: merged.douyin_id || merged.uid || '',
    sec_uid: merged.sec_uid || '',
    aweme_id: isDouyin ? (videoInfo.aweme_id || '') : '',
    video_desc: isDouyin ? (videoInfo.desc || '未采集') : '',
    video_author: isDouyin ? (videoInfo.author || '未采集') : '',
    video_url: isDouyin ? (videoInfo.video_url || (videoInfo.aweme_id ? `https://www.douyin.com/video/${videoInfo.aweme_id}` : '')) : '',
    author_profile: isDouyin ? (videoInfo.authorProfile || '') : '',
    matched_keywords: matchedKeywords,
    score: score,
    digg_count: merged.digg_count || 0,
    reply_count: merged.reply_comment_total || 0,
    like_count: merged.like_count || 0,
    note_id: merged.note_id || '',
    note_title: merged.note_title || '',
    note_author: merged.note_author || '',
    note_url: merged.note_url || '',
    platform: merged.platform || '',
    source: merged.source || (cdpComment ? 'api' : 'dom')
  };

  // 判断平台，选择对应数据库表
  const isXHS = result.platform === 'xhs' || merged.note_id;
  if (isXHS) {
    database.addXHSIntentComment(result);
  } else {
    database.addIntentComment(result);
    // 记录视频信息到 monitor_videos 表
    if (videoInfo && videoInfo.aweme_id) {
      try {
        database.addMonitorVideo({
          aweme_id: videoInfo.aweme_id,
          blogger_sec_uid: videoInfo.blogger_sec_uid || merged.sec_uid || '',
          desc: videoInfo.desc || '',
          create_time: videoInfo.create_time || merged.create_time || 0
        });
      } catch (e) {
        logger.warn(`记录视频信息失败: ${e.message}`);
      }
    }
  }
  notifier.notify(result).catch(e => logger.warn(`推送失败: ${e.message}`));
  logger.info(`[命中] ${result.nickname}: ${result.text.slice(0, 30)} -> ${matchedKeywords.join(',')} (${result.source})`);
  return result;
}

/**
 * 合并 CDP 数据和 DOM 数据
 * CDP 提供完整字段，DOM 补充 CDP 缺失的部分
 */
function mergeCommentData(cdp, dom) {
  if (!cdp && !dom) return null;
  if (!cdp) return dom;
  if (!dom) return cdp;

  return {
    comment_id: cdp.comment_id || dom.comment_id || '',
    uid: cdp.uid || dom.uid || '',
    nickname: cdp.nickname || dom.nickname || '',
    text: cdp.text || dom.text || '',
    ip_label: cdp.ip_label || dom.ip_label || '',
    create_time: cdp.create_time || dom.create_time || 0,
    profile_url: cdp.profile_url || dom.profile_url || '',
    sec_uid: cdp.sec_uid || dom.sec_uid || '',
    douyin_id: cdp.douyin_id || dom.douyin_id || '',
    aweme_id: cdp.aweme_id || dom.aweme_id || '',
    video_desc: cdp.video_desc || dom.video_desc || '',
    video_author: cdp.video_author || dom.video_author || '',
    video_url: cdp.video_url || dom.video_url || '',
    digg_count: cdp.digg_count || dom.digg_count || 0,
    reply_comment_total: cdp.reply_comment_total || dom.reply_comment_total || 0,
    like_count: cdp.like_count || dom.like_count || 0,
    note_id: cdp.note_id || dom.note_id || '',
    note_title: cdp.note_title || dom.note_title || '',
    note_author: cdp.note_author || dom.note_author || '',
    note_url: cdp.note_url || dom.note_url || '',
    platform: cdp.platform || dom.platform || '',
    source: 'merged'
  };
}

// 内存 Set 兜底（数据库未就绪时仍能去重）
const localDedupe = new Set();
const MAX_LOCAL = 20000;

/**
 * 去重（数据库为主，内存 Set 兜底）
 * 优先用数据库（持久化跨进程），fallback 到内存
 */
function isDuplicate(comment) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${comment.nickname || ''}|${comment.text || ''}|${today}`;

  // 1) 数据库去重
  if (database && database.isCommentExists) {
    try {
      if (database.isCommentExists(comment)) {
        return true;
      }
    } catch (e) {
      // 数据库不可用时继续用内存
    }
  }

  // 2) 内存 Set 兜底
  if (localDedupe.has(key)) return true;
  localDedupe.add(key);

  if (localDedupe.size > MAX_LOCAL) {
    // 清理一半
    const arr = Array.from(localDedupe);
    localDedupe.clear();
    arr.slice(arr.length / 2).forEach(k => localDedupe.add(k));
  }
  return false;
}

/**
 * 重置内存去重（切任务时调用）
 */
function resetDedupe() {
  localDedupe.clear();
}

/**
 * 生成唯一 ID
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * 格式化推送消息
 * 根据平台自动选择对应模板，包含平台标识
 */
function formatNotifyMessage(item) {
  const isXHS = item.platform === 'xhs' || item.note_id;
  return isXHS ? formatXHSNotifyMessage(item) : formatDouyinNotifyMessage(item);
}

/**
 * 抖音推送模板 - 标识 [DY]
 */
function formatDouyinNotifyMessage(item) {
  const score = item.score || 0;
  const prefix = score >= 10 ? '🔴【加急】' : score >= 5 ? '🟡【意向】' : '🟢【匹配】';

  let lines = [
    `${prefix} <b>[DY] 抖音意向评论</b>`,
    ``,
    `<b>📝 评论内容：</b>${item.text || ''}`,
    `<b>👤 用户昵称：</b>${item.nickname || ''}`,
    `<b>🆔 用户ID：</b>${item.douyin_id || item.uid || '无'}`,
    `<b>📍 IP属地：</b>${item.ip_label || '未知'}`,
    `<b>⏱️ 评论时间：</b>${formatTime(item.create_time)}`,
    `<b>🏷️ 命中关键词：</b><span style="color:red">${(item.matched_keywords || []).join(', ')}</span>`,
    `<b>📊 时效评分：</b>${score}分`,
    ``,
    `<b>🎬 视频文案：</b>${(item.video_desc || '').slice(0, 80)}`,
    `<b>👤 博主名称：</b>${item.video_author || ''}`,
    `<b>🔗 视频链接：</b><a href="${item.video_url || ''}">${item.video_url || ''}</a>`,
  ];

  if (item.profile_url) {
    lines.push(`<b>🏠 用户主页：</b><a href="${item.profile_url}">${item.profile_url}</a>`);
  }

  return lines.join('\n');
}

/**
 * 小红书推送模板 - 标识 [XHS]
 * 独立设计，字段适配小红书（笔记标题、笔记作者、笔记链接等）
 */
function formatXHSNotifyMessage(item) {
  const score = item.score || 0;
  const prefix = score >= 10 ? '🔴【加急】' : score >= 5 ? '🟡【意向】' : '🟢【匹配】';

  let lines = [
    `${prefix} <b>[XHS] 小红书意向评论</b>`,
    ``,
    `<b>📝 评论内容：</b>${item.text || ''}`,
    `<b>👤 用户昵称：</b>${item.nickname || ''}`,
    `<b>🆔 用户ID：</b>${item.uid || '无'}`,
    `<b>📍 IP属地：</b>${item.ip_label || '未知'}`,
    `<b>⏱️ 评论时间：</b>${formatTime(item.create_time)}`,
    `<b>🏷️ 命中关键词：</b><span style="color:red">${(item.matched_keywords || []).join(', ')}</span>`,
    `<b>📊 时效评分：</b>${score}分`,
    `<b>👍 点赞数：</b>${item.like_count || 0}`,
    ``,
    `<b>📖 笔记标题：</b>${(item.note_title || item.video_desc || '').slice(0, 80)}`,
    `<b>✍️ 笔记作者：</b>${item.note_author || item.video_author || ''}`,
    `<b>🔗 笔记链接：</b><a href="${item.note_url || item.video_url || ''}">${item.note_url || item.video_url || ''}</a>`,
  ];

  if (item.profile_url) {
    lines.push(`<b>🏠 用户主页：</b><a href="${item.profile_url}">${item.profile_url}</a>`);
  }

  return lines.join('\n');
}

function formatTime(ts) {
  if (!ts) return '未知';
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN');
  } catch (e) {
    return '未知';
  }
}

module.exports = { processComment, formatNotifyMessage, isDuplicate, resetDedupe };
