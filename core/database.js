/**
 * SQLite 数据库操作模块
 * 使用 sql.js（纯 JS 实现）替代 better-sqlite3（需要原生编译）
 * 复用原 Python 项目表结构，保持兼容性
 */

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

/** 数据库文件路径 */
const DB_PATH = path.join(__dirname, '..', 'monitor.db');

let db = null;
let SQL = null;
let saveTimer = null;

/**
 * 初始化数据库（异步）
 * @returns {Promise} 初始化完成
 */
async function initDatabase() {
  if (db) return;
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  initTables();
  scheduleSave();
}

/**
 * 获取数据库实例（确保已初始化）
 * @returns {Object} sql.js 数据库实例
 */
async function getDb() {
  if (!db) await initDatabase();
  return db;
}

/**
 * 定期自动保存到磁盘（每 5 秒）
 */
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setInterval(() => {
    saveToDisk();
  }, 5000);
}

/**
 * 将内存数据库写入磁盘
 */
function saveToDisk() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {}
}

/**
 * 初始化数据库表结构
 */
function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aweme_id TEXT UNIQUE NOT NULL,
      blogger_sec_uid TEXT,
      title TEXT,
      publish_time INTEGER,
      last_comment_time INTEGER DEFAULT 0,
      total_intent INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS intent_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aweme_id TEXT,
      comment_id TEXT UNIQUE,
      nickname TEXT,
      douyin_id TEXT,
      sec_uid TEXT,
      profile_url TEXT,
      comment_text TEXT,
      matched_keywords TEXT,
      comment_time INTEGER,
      ip_label TEXT,
      video_author TEXT,
      video_title TEXT,
      video_url TEXT,
      score INTEGER DEFAULT 0,
      capture_time INTEGER,
      email_sent INTEGER DEFAULT 0,
      capture_date TEXT
    );

    CREATE TABLE IF NOT EXISTS run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      content TEXT,
      create_time INTEGER
    );

    CREATE TABLE IF NOT EXISTS notify_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id TEXT,
      channel TEXT,
      status INTEGER DEFAULT 0,
      error_msg TEXT,
      create_time INTEGER
    );
  `);

  // 兼容旧表：尝试添加缺失字段
  const alters = [
    'ALTER TABLE intent_comments ADD COLUMN video_url TEXT',
    'ALTER TABLE intent_comments ADD COLUMN score INTEGER DEFAULT 0',
    'ALTER TABLE intent_comments ADD COLUMN capture_date TEXT'
  ];
  for (const sql of alters) {
    try { db.exec(sql); } catch (e) {}
  }
}

/**
 * 执行查询并返回结果数组
 * @param {string} sql - SQL 语句
 * @param {Array} params - 参数
 * @returns {Array<Object>}
 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

/**
 * 执行查询返回单行
 * @param {string} sql - SQL 语句
 * @param {Array} params - 参数
 * @returns {Object|null}
 */
function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

/**
 * 执行写入操作
 * @param {string} sql - SQL 语句
 * @param {Array} params - 参数
 */
function run(sql, params = []) {
  db.run(sql, params);
  saveToDisk();
}

// ========== 视频表操作 ==========

function addMonitorVideo(videoInfo) {
  try {
    run(
      `INSERT OR IGNORE INTO monitor_videos (aweme_id, blogger_sec_uid, title, publish_time, status)
       VALUES (?, ?, ?, ?, 1)`,
      [videoInfo.aweme_id, videoInfo.blogger_sec_uid || '', videoInfo.desc || '', videoInfo.create_time || 0]
    );
    return true;
  } catch (e) {
    return false;
  }
}

function getVideoCursor(awemeId) {
  const row = queryOne('SELECT last_comment_time FROM monitor_videos WHERE aweme_id=?', [awemeId]);
  return row ? row.last_comment_time : 0;
}

function updateVideoCursor(awemeId, lastTime) {
  run('UPDATE monitor_videos SET last_comment_time=? WHERE aweme_id=?', [lastTime, awemeId]);
}

// ========== 意向评论操作 ==========

function addIntentComment(commentInfo) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const today = new Date().toISOString().slice(0, 10);

    const douyinId = commentInfo.douyin_id || '';
    const nickname = commentInfo.nickname || '';
    const commentText = commentInfo.text || commentInfo.comment_text || '';

    const dup = queryOne(
      'SELECT id FROM intent_comments WHERE douyin_id=? AND nickname=? AND comment_text=? AND capture_date=?',
      [douyinId, nickname, commentText, today]
    );
    if (dup) return false;

    const keywords = Array.isArray(commentInfo.matched_keywords)
      ? commentInfo.matched_keywords.join(',')
      : (commentInfo.matched_keywords || '');

    run(
      `INSERT OR IGNORE INTO intent_comments
       (aweme_id, comment_id, nickname, douyin_id, sec_uid, profile_url,
        comment_text, matched_keywords, comment_time, ip_label,
        video_author, video_title, video_url, score, capture_time, email_sent, capture_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        commentInfo.aweme_id || '',
        commentInfo.comment_id || '',
        nickname, douyinId,
        commentInfo.sec_uid || '',
        commentInfo.profile || commentInfo.profile_url || '',
        commentText, keywords,
        commentInfo.create_time || commentInfo.comment_time || now,
        commentInfo.ip || commentInfo.ip_label || '',
        commentInfo.video_author || '',
        commentInfo.video_info || commentInfo.video_title || '',
        commentInfo.video_url || '',
        commentInfo.score || 0,
        now, today
      ]
    );
    return true;
  } catch (e) {
    return false;
  }
}

function getUnsentEmails(limit = 10) {
  return queryAll('SELECT * FROM intent_comments WHERE email_sent=0 ORDER BY id ASC LIMIT ?', [limit]);
}

function markEmailSent(commentId) {
  run('UPDATE intent_comments SET email_sent=1 WHERE comment_id=?', [commentId]);
}

// ========== 日志操作 ==========

function addLog(type, content) {
  const now = Math.floor(Date.now() / 1000);
  run('INSERT INTO run_logs (type, content, create_time) VALUES (?, ?, ?)', [type, content, now]);
}

// ========== 通知记录 ==========

function addNotifyLog(commentId, channel, status, errorMsg = '') {
  const now = Math.floor(Date.now() / 1000);
  run(
    'INSERT INTO notify_logs (comment_id, channel, status, error_msg, create_time) VALUES (?, ?, ?, ?, ?)',
    [commentId, channel, status, errorMsg, now]
  );
}

// ========== 统计查询 ==========

function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    total_comments: queryOne('SELECT COUNT(*) as c FROM intent_comments')?.c || 0,
    today_matches: queryOne('SELECT COUNT(*) as c FROM intent_comments WHERE capture_date=?', [today])?.c || 0,
    today_emails: queryOne('SELECT COUNT(*) as c FROM intent_comments WHERE email_sent=1 AND capture_date=?', [today])?.c || 0,
    total_videos: queryOne('SELECT COUNT(*) as c FROM monitor_videos')?.c || 0,
    total_emails: queryOne('SELECT COUNT(*) as c FROM intent_comments WHERE email_sent=1')?.c || 0
  };
}

function getRecentMatches(limit = 20) {
  return queryAll('SELECT * FROM intent_comments ORDER BY id DESC LIMIT ?', [limit]);
}

module.exports = {
  getDb,
  initDatabase,
  addMonitorVideo,
  getVideoCursor,
  updateVideoCursor,
  addIntentComment,
  getUnsentEmails,
  markEmailSent,
  addLog,
  addNotifyLog,
  getStats,
  getRecentMatches,
  saveToDisk
};
