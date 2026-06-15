/**
 * 数据处理管道
 * 完整采集字段：
 *   用户ID / 用户名称 / 评论内容 / IP属地 / 评论时间
 *   视频文案 / 视频链接 / 博主名称
 * 双重采集：CDP API拦截（主）+ DOM采集（备）
 * 数据去重 + 关键词匹配 + 评分 + 入库 + 推送
 */

const { matchIntent, calcCommentScore } = require('./match');
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
function processComment(cdpComment, domComment, videoInfo, keywords) {
  // 合并数据（CDP 优先，DOM 补充）
  const merged = mergeCommentData(cdpComment, domComment);

  if (!merged || !merged.text || merged.text.length < 3) return null;

  // 去重检查
  if (isDuplicate(merged)) return null;

  // 关键词匹配
  const [matched, matchedKeywords, isGarbage] = matchIntent(
    merged.text, keywords.intent || [], keywords.garbage || []
  );

  if (!matched || isGarbage) return null;

  // 计算评分
  const score = calcCommentScore(merged.create_time);

  // 构建完整数据
  const result = {
    comment_id: merged.comment_id || generateId(),
    uid: merged.uid || '',
    nickname: merged.nickname || '',
    text: merged.text,
    ip_label: merged.ip_label || '',
    create_time: merged.create_time || 0,
    profile_url: merged.profile_url || '',
    douyin_id: merged.douyin_id || '',
    aweme_id: videoInfo.aweme_id || merged.aweme_id || '',
    video_desc: videoInfo.desc || merged.video_desc || '',
    video_author: videoInfo.author || merged.video_author || '',
    video_url: videoInfo.video_url || merged.video_url || `https://www.douyin.com/video/${videoInfo.aweme_id}`,
    matched_keywords: matchedKeywords,
    score: score,
    digg_count: merged.digg_count || 0,
    reply_count: merged.reply_comment_total || 0,
    source: cdpComment ? 'api' : 'dom'
  };

  // 入库
  database.addIntentComment(result);

  // 异步推送通知（捕获异常避免未处理拒绝）
  notifier.notify(result).catch(e => {
    logger.warn(`推送通知失败: ${e.message}`);
  });

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
    digg_count: cdp.digg_count || 0,
    reply_comment_total: cdp.reply_comment_total || 0,
    source: 'merged'
  };
}

/**
 * 简单去重（基于昵称+评论内容+日期）
 */
function isDuplicate(comment) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${comment.nickname}|${comment.text}|${today}`;
  if (!isDuplicate._set) isDuplicate._set = new Set();
  if (isDuplicate._set.has(key)) return true;
  isDuplicate._set.add(key);

  // 定期清理
  if (isDuplicate._set.size > 10000) {
    isDuplicate._set.clear();
  }
  return false;
}

/**
 * 生成唯一 ID
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * 格式化推送消息
 * 包含所有采集字段的完整排版
 */
function formatNotifyMessage(item) {
  const score = item.score || 0;
  const prefix = score >= 10 ? '🔴【加急】' : score >= 5 ? '🟡【意向】' : '🟢【匹配】';

  let lines = [
    `${prefix} <b>抖音意向评论</b>`,
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

function formatTime(ts) {
  if (!ts) return '未知';
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN');
  } catch (e) {
    return '未知';
  }
}

module.exports = { processComment, formatNotifyMessage };
