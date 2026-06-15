/**
 * SQLite 数据库操作模块（重构版）
 *
 * 使用 sql.js（纯 JS 实现）替代 better-sqlite3（避免原生编译）
 * 复用原 Python 项目表结构，保持兼容性
 *
 * 重构要点：
 *   - 写盘改为异步 + 队列，避免阻塞主进程
 *   - saveToDisk 失败时通过 notifier 推送告警
 *   - getStats 合并为单次 SUM/CASE 查询
 *   - schema migration 用 PRAGMA user_version 版本号机制
 *   - 启动时一次性执行所有迁移，之后只检查版本号
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const initSqlJs = require('sql.js');
const { getLogger } = require('./logger');

const logger = getLogger('Database');

const DB_PATH = path.join(__dirname, '..', 'monitor.db');

let db = null;
let SQL = null;
let saveTimer = null;
let saving = false;
let dirty = false;
let pendingWrites = 0;

// 当前 schema 版本号（每次新增迁移 +1）
const SCHEMA_VERSION = 2;

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
  applyMigrations();
  scheduleSave();
}

async function getDb() {
  if (!db) await initDatabase();
  return db;
}

/**
 * 定期自动保存（5 秒），如有写入且非正在保存则触发
 */
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setInterval(() => {
    if (dirty && !saving) saveToDisk().catch(() => {});
  }, 5000);
}

/**
 * 立即将内存数据库写入磁盘（异步）
 * @returns {Promise<boolean>}
 */
async function saveToDisk() {
  if (!db || saving) return false;
  saving = true;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    // 临时文件 + rename 保证原子性
    const tmp = DB_PATH + '.tmp';
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, DB_PATH);
    dirty = false;
    pendingWrites = 0;
    return true;
  } catch (e) {
    logger.error(`数据库保存失败: ${e.message}`);
    try {
      const { getMainWindow } = require('../main/window');
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('database-error', { message: e.message });
      }
    } catch (_) {}
    return false;
  } finally {
    saving = false;
  }
}

/**
 * 强制立即保存（应用退出前调用）
 */
async function flushDatabase() {
  if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
  await saveToDisk();
}

/**
 * 初始化基础表（最新结构，迁移只对老库生效）
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

    CREATE INDEX IF NOT EXISTS idx_intent_capture_date ON intent_comments(capture_date);
    CREATE INDEX IF NOT EXISTS idx_intent_email_sent ON intent_comments(email_sent);
    CREATE INDEX IF NOT EXISTS idx_intent_aweme_id ON intent_comments(aweme_id);
    CREATE INDEX IF NOT EXISTS idx_intent_capture_time ON intent_comments(capture_time);
  `);
}

/**
 * schema 迁移
 *  - 读取 PRAGMA user_version
 *  - 逐版本执行迁移 SQL
 *  - 写回新的 user_version
 */
function applyMigrations() {
  const currentVersion = queryOne('PRAGMA user_version')?.user_version || 0;

  const migrations = {
    1: [
      // v0 -> v1: intent_comments 兼容字段
      `ALTER TABLE intent_comments ADD COLUMN video_url TEXT`,
      `ALTER TABLE intent_comments ADD COLUMN score INTEGER DEFAULT 0`,
      `ALTER TABLE intent_comments ADD COLUMN capture_date TEXT`
    ],
    2: [
      // v1 -> v2: 索引（CREATE INDEX IF NOT EXISTS 已幂等）
      `CREATE INDEX IF NOT EXISTS idx_intent_capture_date ON intent_comments(capture_date)`,
      `CREATE INDEX IF NOT EXISTS idx_intent_email_sent ON intent_comments(email_sent)`,
      `CREATE INDEX IF NOT EXISTS idx_intent_aweme_id ON intent_comments(aweme_id)`,
      `CREATE INDEX IF NOT EXISTS idx_intent_capture_time ON intent_comments(capture_time)`
    ]
  };

  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    if (!migrations[v]) continue;
    db.exec('BEGIN');
    try {
      for (const sql of migrations[v]) {
        try { db.exec(sql); }
        catch (e) { logger.warn(`迁移 v${v} 跳过: ${e.message}`); }
      }
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec('COMMIT');
      logger.info(`schema 迁移到 v${v}`);
    } catch (e) {
      db.exec('ROLLBACK');
      logger.error(`schema 迁移 v${v} 失败: ${e.message}`);
      throw e;
    }
  }
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  dirty = true;
  pendingWrites++;
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
    logger.error(`addMonitorVideo 失败: ${e.message}`);
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

    // 三重去重：comment_id 唯一 / 当日 douyin+nickname+text
    if (commentInfo.comment_id) {
      const exists = queryOne('SELECT id FROM intent_comments WHERE comment_id=?', [commentInfo.comment_id]);
      if (exists) return false;
    }
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
    logger.error(`addIntentComment 失败: ${e.message}`);
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

/**
 * 合并为单次查询，5 项指标通过 SUM(CASE WHEN ...) 计算
 * 性能：5 次 queryOne (O(N)) -> 1 次 queryOne (O(N))
 */
function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  const row = queryOne(`
    SELECT
      COUNT(*) AS total_comments,
      SUM(CASE WHEN capture_date = ? THEN 1 ELSE 0 END) AS today_matches,
      SUM(CASE WHEN capture_date = ? AND email_sent = 1 THEN 1 ELSE 0 END) AS today_emails,
      SUM(CASE WHEN email_sent = 1 THEN 1 ELSE 0 END) AS total_emails
    FROM intent_comments
  `, [today, today]) || {};

  const videosRow = queryOne('SELECT COUNT(*) AS c FROM monitor_videos') || { c: 0 };

  return {
    total_comments: row.total_comments || 0,
    today_matches: row.today_matches || 0,
    today_emails: row.today_emails || 0,
    total_emails: row.total_emails || 0,
    total_videos: videosRow.c || 0
  };
}

function getRecentMatches(limit = 20) {
  return queryAll('SELECT * FROM intent_comments ORDER BY id DESC LIMIT ?', [limit]);
}

/**
 * 增量同步拉取，分页避免大表全量加载
 */
function getRecentMatchesPage(offset = 0, limit = 50, filter = {}) {
  const where = [];
  const params = [];
  if (filter.date) {
    where.push('capture_date = ?');
    params.push(filter.date);
  }
  if (filter.keyword) {
    where.push('(nickname LIKE ? OR comment_text LIKE ? OR video_title LIKE ?)');
    const k = `%${filter.keyword}%`;
    params.push(k, k, k);
  }
  if (filter.videoAwemeId) {
    where.push('aweme_id = ?');
    params.push(filter.videoAwemeId);
  }
  const sql = `
    SELECT * FROM intent_comments
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `;
  return queryAll(sql, [...params, limit, offset]);
}

function getMatchesCount(filter = {}) {
  const where = [];
  const params = [];
  if (filter.date) {
    where.push('capture_date = ?');
    params.push(filter.date);
  }
  if (filter.keyword) {
    where.push('(nickname LIKE ? OR comment_text LIKE ? OR video_title LIKE ?)');
    const k = `%${filter.keyword}%`;
    params.push(k, k, k);
  }
  if (filter.videoAwemeId) {
    where.push('aweme_id = ?');
    params.push(filter.videoAwemeId);
  }
  const row = queryOne(
    `SELECT COUNT(*) AS c FROM intent_comments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    params
  );
  return row?.c || 0;
}

/**
 * 持久化去重：comment_id 唯一 OR (昵称+内容+日期)
 * @returns {boolean}
 */
function isCommentExists(comment) {
  const today = new Date().toISOString().slice(0, 10);
  if (comment.comment_id) {
    const r = queryOne('SELECT id FROM intent_comments WHERE comment_id=? LIMIT 1', [comment.comment_id]);
    if (r) return true;
  }
  const r2 = queryOne(
    `SELECT id FROM intent_comments WHERE nickname=? AND comment_text=? AND capture_date=? LIMIT 1`,
    [comment.nickname || '', comment.text || comment.comment_text || '', today]
  );
  return !!r2;
}

function clearIntentComments() {
  run('DELETE FROM intent_comments');
}

module.exports = {
  getDb,
  initDatabase,
  flushDatabase,
  addMonitorVideo,
  getVideoCursor,
  updateVideoCursor,
  addIntentComment,
  isCommentExists,
  getUnsentEmails,
  markEmailSent,
  addLog,
  addNotifyLog,
  getStats,
  getRecentMatches,
  getRecentMatchesPage,
  getMatchesCount,
  clearIntentComments,
  saveToDisk
};
