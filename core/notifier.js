/**
 * 通知调度器
 * 统一管理邮件和企业微信推送
 * 支持同时启用多个通知渠道，独立发送
 */

const email = require('./email');
const wechat = require('./wechat');
const { addNotifyLog } = require('./database');

let currentConfig = null;

/**
 * 重新加载配置
 * @param {Object} cfg - 全局配置对象
 */
function reload(cfg) {
  currentConfig = cfg;
}

/**
 * 发送通知（同时发送邮件和企微）
 * @param {Object} item - 评论数据
 * @returns {Promise<Object>} { email: boolean, wechat: boolean }
 */
async function notify(item) {
  if (!currentConfig) return { email: false, wechat: false };

  const results = { email: false, wechat: false };

  // 并行发送邮件和企微
  const promises = [];

  if (currentConfig.email && currentConfig.email.enable) {
    promises.push(
      email.sendOne(item, currentConfig.email).then(ok => {
        results.email = ok;
        addNotifyLog(item.comment_id || '', 'email', ok ? 1 : 2);
      })
    );
  }

  if (currentConfig.wechat && currentConfig.wechat.enable) {
    promises.push(
      wechat.sendOne(item, currentConfig.wechat).then(ok => {
        results.wechat = ok;
        addNotifyLog(item.comment_id || '', 'wechat', ok ? 1 : 2);
      })
    );
  }

  await Promise.all(promises);
  return results;
}

/**
 * 发送加急通知（评分 >= 10 时触发）
 * 无论配置如何，都会尝试发送
 * @param {Object} item - 评论数据
 * @param {string} reason - 加急原因
 * @returns {Promise<Object>}
 */
async function sendUrgent(item, reason) {
  const urgentItem = {
    ...item,
    nickname: '系统通知',
    douyin_id: 'SYSTEM',
    comment_text: `程序检测到异常：${reason}\n\n需要人工干预处理。`,
    matched_keywords: '系统通知',
    score: 10,
    video_author: '抖音监控系统',
    video_url: 'https://www.douyin.com/'
  };

  return notify(urgentItem);
}

module.exports = { reload, notify, sendUrgent };
