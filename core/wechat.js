/**
 * 企业微信 Webhook 推送模块
 * 通过企业微信群机器人 Webhook 发送意向评论通知
 * 支持 markdown 格式消息
 */

const axios = require('axios');

/**
 * 发送单条意向评论到企业微信
 * @param {Object} item - 评论数据
 * @param {Object} wechatCfg - 企微配置 { enable, webhook_url }
 * @returns {Promise<boolean>} 是否发送成功
 */
async function sendOne(item, wechatCfg) {
  if (!wechatCfg || !wechatCfg.enable || !wechatCfg.webhook_url) return false;

  for (let retry = 0; retry < 3; retry++) {
    try {
      const content = buildMarkdown(item);
      const resp = await axios.post(wechatCfg.webhook_url, {
        msgtype: 'markdown',
        markdown: { content }
      }, { timeout: 10000 });

      if (resp.data && resp.data.errcode === 0) {
        return true;
      }
    } catch (e) {
      await sleep(2000 * (retry + 1));
    }
  }

  return false;
}

/**
 * 发送企微测试消息
 * @param {Object} wechatCfg - 企微配置
 * @returns {Promise<boolean>}
 */
async function sendTest(wechatCfg) {
  const testItem = {
    nickname: '测试用户',
    douyin_id: 'test123',
    comment_text: '这是一条测试消息，请问价格是多少？',
    matched_keywords: '价格,咨询',
    comment_time: Math.floor(Date.now() / 1000),
    ip_label: '四川',
    video_author: '测试博主',
    video_url: 'https://www.douyin.com/video/test',
    score: 10
  };
  return sendOne(testItem, wechatCfg);
}

/**
 * 构建 markdown 格式消息内容
 * 企业微信 markdown 支持有限（不支持表格、图片等）
 * 根据平台自动选择模板：抖音[DY] / 小红书[XHS]
 * @param {Object} item - 评论数据
 * @returns {string} markdown 字符串
 */
function buildMarkdown(item) {
  const score = item.score || 0;
  const isXHS = item.platform === 'xhs' || item.note_id;

  if (isXHS) {
    return buildXHSMarkdown(item, score);
  }
  return buildDouyinMarkdown(item, score);
}

/**
 * 抖音推送模板 - 标识 [DY]
 */
function buildDouyinMarkdown(item, score) {
  const scoreLabel = score >= 10 ? '🔴时效评论' : score >= 5 ? '🟡近期评论' : '🟢历史评论';
  const prefix = score >= 10 ? '⚠️【加急】' : '📌【意向】';

  let lines = [
    `${prefix}<font color="info">[DY] 抖音意向评论</font>`,
    `> 评分: <font color="warning">${score}分</font> | ${scoreLabel}`,
    `---`,
    `**用户昵称**: ${item.nickname || '未采集'}`,
    `**抖音号**: ${item.douyin_id || '未采集'}`,
    `**评论内容**: ${item.comment_text || item.text || '未采集'}`,
    `**命中关键词**: <font color="warning">${item.matched_keywords || '未匹配'}</font>`,
    `**评论时间**: ${formatTime(item.comment_time || item.create_time)}`,
    `**IP属地**: ${item.ip_label || '未采集'}`,
    `**视频文案**: ${(item.video_desc || '').slice(0, 80) || '未采集'}`,
    `**用户主页**: ${item.profile_url ? `[点击访问](${item.profile_url})` : '未采集'}`,
    `**原作品**: ${item.video_url ? `[点击查看](${item.video_url})` : '未采集'}`,
  ];

  lines.push(`---`);
  lines.push(`> 系统自动采集 · 实时推送`);

  return lines.join('\n');
}

/**
 * 小红书推送模板 - 标识 [XHS]
 */
function buildXHSMarkdown(item, score) {
  const scoreLabel = score >= 10 ? '🔴时效评论' : score >= 5 ? '🟡近期评论' : '🟢历史评论';
  const prefix = score >= 10 ? '⚠️【加急】' : '📌【意向】';

  let lines = [
    `${prefix}<font color="info">[XHS] 小红书意向评论</font>`,
    `> 评分: <font color="warning">${score}分</font> | ${scoreLabel}`,
    `---`,
    `**用户昵称**: ${item.nickname || '未采集'}`,
    `**用户ID**: ${item.uid || '未采集'}`,
    `**评论内容**: ${item.comment_text || item.text || '未采集'}`,
    `**命中关键词**: <font color="warning">${item.matched_keywords || '未匹配'}</font>`,
    `**评论时间**: ${formatTime(item.comment_time || item.create_time)}`,
    `**IP属地**: ${item.ip_label || '未采集'}`,
    `**点赞数**: ${item.like_count || 0}`,
    `**笔记标题**: ${(item.note_title || item.video_desc || '').slice(0, 80) || '未采集'}`,
    `**笔记作者**: ${item.note_author || item.video_author || '未采集'}`,
    `**用户主页**: ${item.profile_url ? `[点击访问](${item.profile_url})` : '未采集'}`,
    `**笔记链接**: ${item.note_url || item.video_url ? `[点击查看](${item.note_url || item.video_url})` : '未采集'}`,
  ];

  lines.push(`---`);
  lines.push(`> 系统自动采集 · 实时推送`);

  return lines.join('\n');
}

/**
 * 格式化时间戳
 * @param {number} ts - Unix 时间戳（秒）
 * @returns {string}
 */
function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN');
  } catch (e) {
    return '';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { sendOne, sendTest };
