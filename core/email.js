/**
 * 邮件推送服务
 * 使用 nodemailer 发送 HTML 格式的意向评论通知
 * 支持 SMTP SSL/TLS，带重试机制
 */

const nodemailer = require('nodemailer');
const { addNotifyLog } = require('./database');

/**
 * 发送单条意向评论邮件
 * @param {Object} item - 评论数据
 * @param {Object} emailCfg - 邮件配置 { smtp_server, smtp_port, sender, auth_code, receivers }
 * @returns {Promise<boolean>} 是否发送成功
 */
async function sendOne(item, emailCfg) {
  if (!emailCfg || !emailCfg.enable || !emailCfg.sender) return false;

  const receivers = parseReceivers(emailCfg.receivers);
  if (receivers.length === 0) return false;

  for (let retry = 0; retry < 3; retry++) {
    try {
      const transporter = createTransporter(emailCfg);
      const mailOptions = buildMailOptions(item, emailCfg, receivers);
      await transporter.sendMail(mailOptions);
      transporter.close();
      return true;
    } catch (e) {
      await sleep(2000 * (retry + 1));
    }
  }

  addNotifyLog(item.comment_id || '', 'email', 2, '发送失败');
  return false;
}

/**
 * 发送测试邮件
 * @param {Object} emailCfg - 邮件配置
 * @returns {Promise<boolean>}
 */
async function sendTest(emailCfg) {
  const testItem = {
    nickname: '测试用户',
    douyin_id: 'test123',
    profile_url: 'https://www.douyin.com/',
    comment_text: '这是一条测试邮件，请问价格是多少？',
    matched_keywords: '价格,咨询',
    comment_time: Math.floor(Date.now() / 1000),
    ip_label: '四川',
    video_author: '测试博主',
    video_title: '测试视频标题',
    video_url: 'https://www.douyin.com/video/test',
    score: 10
  };
  return sendOne(testItem, emailCfg);
}

/**
 * 创建邮件传输器
 * @param {Object} cfg - 邮件配置
 * @returns {nodemailer.Transporter}
 */
function createTransporter(cfg) {
  const port = parseInt(cfg.smtp_port) || 465;

  if (port === 465) {
    return nodemailer.createTransport({
      host: cfg.smtp_server,
      port: 465,
      secure: true,
      auth: { user: cfg.sender, pass: cfg.auth_code },
      tls: { rejectUnauthorized: false }
    });
  }

  return nodemailer.createTransport({
    host: cfg.smtp_server,
    port: port,
    secure: false,
    auth: { user: cfg.sender, pass: cfg.auth_code },
    tls: { rejectUnauthorized: false }
  });
}

/**
 * 构建邮件选项
 * @param {Object} item - 评论数据
 * @param {Object} cfg - 邮件配置
 * @param {Array} receivers - 收件人列表
 * @returns {Object} nodemailer mail options
 */
function buildMailOptions(item, cfg, receivers) {
  const score = item.score || 0;
  const prefix = score >= 10 ? '【加急】' : '【意向】';

  return {
    from: `抖音监控系统 <${cfg.sender}>`,
    to: receivers.join(', '),
    subject: `${prefix}${item.video_author || ''} - ${item.nickname || ''} 发表意向评论 (${score}分)`,
    html: buildHtml(item)
  };
}

/**
 * 构建邮件 HTML 内容
 * @param {Object} item - 评论数据
 * @returns {string} HTML 字符串
 */
function buildHtml(item) {
  const score = item.score || 0;
  const scoreColor = score >= 10 ? '#d93025' : score >= 5 ? '#f9ab00' : '#34a853';
  const scoreLabel = score >= 10 ? '时效评论' : score >= 5 ? '近期评论' : '历史评论';
  const headerBg = score >= 10 ? '#d93025' : '#1a73e8';
  const videoUrl = item.video_url || '';

  return `
<div style="max-width:680px;margin:0 auto;font-family:'Microsoft YaHei',sans-serif;">
  <div style="background:${headerBg};color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;font-size:18px;">${score >= 10 ? '[加急] ' : ''}抖音意向评论实时告警</h2>
    <p style="margin:5px 0 0;opacity:0.9;">系统自动采集 · 实时推送 · 评分 ${score}分</p>
  </div>
  <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px;padding:20px 24px;background:#fafafa;">
    <div style="text-align:center;margin-bottom:15px;">
      <span style="display:inline-block;padding:6px 16px;border-radius:20px;background:${scoreColor};color:#fff;font-size:13px;font-weight:bold;">
        ${scoreLabel} · ${score}分
      </span>
    </div>
    <table width="100%" cellpadding="8" cellspacing="0">
      <tr><td width="90" style="color:#666;">用户昵称</td><td style="font-weight:bold;color:#333;">${escapeHtml(item.nickname || '未采集')}</td></tr>
      <tr><td style="color:#666;">抖音号</td><td>${escapeHtml(item.douyin_id || '未采集')}</td></tr>
      <tr><td style="color:#666;">主页链接</td><td><a href="${escapeHtml(item.profile_url || '')}" target="_blank" style="color:#1a73e8;">${item.profile_url ? '点击访问' : '未采集'}</a></td></tr>
      <tr><td style="color:#666;">评论内容</td><td style="background:#fff;padding:10px;border-radius:4px;">${escapeHtml(item.comment_text || item.text || '未采集')}</td></tr>
      <tr><td style="color:#666;">命中关键词</td><td style="color:#d93025;font-weight:bold;">${escapeHtml(item.matched_keywords || '未匹配')}</td></tr>
      <tr><td style="color:#666;">评论时间</td><td>${formatTime(item.comment_time || item.create_time)}</td></tr>
      <tr><td style="color:#666;">IP属地</td><td>${escapeHtml(item.ip_label || '未采集')}</td></tr>
      <tr><td style="color:#666;">所属博主</td><td>${escapeHtml(item.video_author || '未采集')}</td></tr>
      <tr><td style="color:#666;">视频标题</td><td>${escapeHtml((item.video_title || item.video_desc || '').slice(0, 50))}</td></tr>
      <tr><td style="color:#666;">原作品</td><td><a href="${escapeHtml(videoUrl)}" target="_blank" style="color:#1a73e8;">${escapeHtml(videoUrl.slice(0, 60))}${videoUrl.length > 60 ? '...' : ''}</a></td></tr>
    </table>
  </div>
  <p style="text-align:center;color:#999;font-size:12px;margin-top:15px;">本邮件由系统自动发送，请勿直接回复</p>
</div>`;
}

/**
 * 解析收件人列表
 * @param {string} receiversStr - 逗号分隔的收件人字符串
 * @returns {Array<string>}
 */
function parseReceivers(receiversStr) {
  if (!receiversStr) return [];
  return receiversStr.replace(/，/g, ',').split(',').map(s => s.trim()).filter(Boolean);
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { sendOne, sendTest };
