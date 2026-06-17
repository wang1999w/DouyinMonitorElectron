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
const SCHEMA_VERSION = 5;

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
  cleanupExpiredData();  // 自动清理过期数据（只保留最近2天）
  scheduleSave();
}

async function getDb() {
  if (!db) await initDatabase();
  return db;
}

/**
 * 清理过期数据（只保留最近2天的业务数据，避免数据库无限增长）
 *  - 评论数据：保留今天和昨天
 *  - 视频/笔记：仅保留与近期评论关联的
 *  - 运行日志：保留最近3天
 */
function cleanupExpiredData() {
  if (!db) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const now = Math.floor(Date.now() / 1000);
    const keepCommentDays = 2;
    const cutoffTs = now - keepCommentDays * 86400;
    const logCutoff = now - 3 * 86400;

    // 1. 清理过期的抖音意向评论（删除3天前及更早的数据）
    let delComments = 0;
    try {
      const r = db.run(`DELETE FROM intent_comments WHERE capture_date NOT IN ('${today}', '${yesterday}')`);
      delComments = r && typeof r.changes === 'number' ? r.changes : 0;
    } catch (_) {}

    // 2. 清理过期的小红书意向评论
    let delXhsComments = 0;
    try {
      const r = db.run(`DELETE FROM xhs_intent_comments WHERE capture_date NOT IN ('${today}', '${yesterday}')`);
      delXhsComments = r && typeof r.changes === 'number' ? r.changes : 0;
    } catch (_) {}

    // 3. 清理无关联的视频记录（只保留与近期评论关联的视频）
    let delVideos = 0;
    try {
      const r = db.run(`DELETE FROM monitor_videos WHERE aweme_id NOT IN (SELECT aweme_id FROM intent_comments WHERE capture_date IN ('${today}', '${yesterday}'))`);
      delVideos = r && typeof r.changes === 'number' ? r.changes : 0;
    } catch (_) {}

    // 4. 清理过期小红书笔记
    let delNotes = 0;
    try {
      const r = db.run(`DELETE FROM xhs_notes WHERE note_id NOT IN (SELECT note_id FROM xhs_intent_comments WHERE capture_date IN ('${today}', '${yesterday}'))`);
      delNotes = r && typeof r.changes === 'number' ? r.changes : 0;
    } catch (_) {}

    // 5. 清理3天前的运行日志
    try {
      db.run('DELETE FROM run_logs WHERE create_time < ' + logCutoff);
    } catch (_) {}

    // 6. 清理3天前的通知日志
    try {
      db.run('DELETE FROM notify_logs WHERE create_time < ' + logCutoff);
    } catch (_) {}

    // 7. 记录本次清理信息到 meta 表
    try {
      const ts = now;
      db.run(`INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_cleanup', '${today}', ${ts})`);
    } catch (_) {}

    dirty = true;
    logger.info(`[数据库] 过期数据清理完成: 抖音评论-${delComments}条, 小红书评论-${delXhsComments}条, 旧视频-${delVideos}条, 旧笔记-${delNotes}条`);
  } catch (e) {
    logger.warn(`[数据库] 清理过期数据失败: ${e.message}`);
  }
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
  const MAX_RETRIES = 5;
  const RETRY_INTERVAL = 500;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    const tmp = DB_PATH + '.tmp';
    await fsp.writeFile(tmp, buffer);
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await fsp.rename(tmp, DB_PATH);
        dirty = false;
        pendingWrites = 0;
        if (attempt > 1) {
          logger.info(`数据库保存成功（第 ${attempt} 次重试）`);
        }
        return true;
      } catch (e) {
        lastError = e;
        if (e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EPERM') {
          logger.warn(`数据库保存第 ${attempt}/${MAX_RETRIES} 次失败（${e.code}），${RETRY_INTERVAL}ms 后重试`);
          await new Promise(r => setTimeout(r, RETRY_INTERVAL));
          continue;
        }
        throw e;
      }
    }
    throw lastError || new Error('save failed after retries');
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
      capture_date TEXT,
      source TEXT DEFAULT 'api'
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

    CREATE TABLE IF NOT EXISTS xhs_intent_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT,
      comment_id TEXT UNIQUE,
      nickname TEXT,
      user_id TEXT,
      profile_url TEXT,
      comment_text TEXT,
      matched_keywords TEXT,
      comment_time INTEGER,
      ip_label TEXT,
      note_author TEXT,
      note_title TEXT,
      note_url TEXT,
      score INTEGER DEFAULT 0,
      capture_time INTEGER,
      email_sent INTEGER DEFAULT 0,
      capture_date TEXT,
      source TEXT DEFAULT 'api',
      platform TEXT DEFAULT 'xhs'
    );

    CREATE TABLE IF NOT EXISTS xhs_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT UNIQUE NOT NULL,
      blogger_user_id TEXT,
      title TEXT,
      publish_time INTEGER,
      last_comment_time INTEGER DEFAULT 0,
      total_intent INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_xhs_intent_capture_date ON xhs_intent_comments(capture_date);
    CREATE INDEX IF NOT EXISTS idx_xhs_intent_email_sent ON xhs_intent_comments(email_sent);
    CREATE INDEX IF NOT EXISTS idx_xhs_intent_note_id ON xhs_intent_comments(note_id);
    CREATE INDEX IF NOT EXISTS idx_xhs_intent_capture_time ON xhs_intent_comments(capture_time);

    CREATE INDEX IF NOT EXISTS idx_intent_capture_date ON intent_comments(capture_date);
    CREATE INDEX IF NOT EXISTS idx_intent_email_sent ON intent_comments(email_sent);
    CREATE INDEX IF NOT EXISTS idx_intent_aweme_id ON intent_comments(aweme_id);
    CREATE INDEX IF NOT EXISTS idx_intent_capture_time ON intent_comments(capture_time);

    -- 元信息表（记录清理日期等配置）
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );
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
    ],
    3: [
      // v2 -> v3: 添加 source 列（区分 api/dom 来源）
      `ALTER TABLE intent_comments ADD COLUMN source TEXT DEFAULT 'api'`
    ],
    4: [
      // v3 -> v4: 修复 profile_url 重复拼接（https://www.douyin.com//www.douyin.com/user/... -> https://www.douyin.com/user/...）
      `UPDATE intent_comments SET profile_url = REPLACE(profile_url, 'https://www.douyin.com//www.douyin.com/', 'https://www.douyin.com/') WHERE profile_url LIKE 'https://www.douyin.com//www.douyin.com/%'`,
      `UPDATE intent_comments SET profile_url = REPLACE(profile_url, 'https://www.douyin.com/www.douyin.com/', 'https://www.douyin.com/') WHERE profile_url LIKE 'https://www.douyin.com/www.douyin.com/%'`
    ],
    5: [
      // v4 -> v5: 新增小红书表
      `CREATE TABLE IF NOT EXISTS xhs_intent_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT,
        comment_id TEXT UNIQUE,
        nickname TEXT,
        user_id TEXT,
        profile_url TEXT,
        comment_text TEXT,
        matched_keywords TEXT,
        comment_time INTEGER,
        ip_label TEXT,
        note_author TEXT,
        note_title TEXT,
        note_url TEXT,
        score INTEGER DEFAULT 0,
        capture_time INTEGER,
        email_sent INTEGER DEFAULT 0,
        capture_date TEXT,
        source TEXT DEFAULT 'api',
        platform TEXT DEFAULT 'xhs'
      )`,
      `CREATE TABLE IF NOT EXISTS xhs_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT UNIQUE NOT NULL,
        blogger_user_id TEXT,
        title TEXT,
        publish_time INTEGER,
        last_comment_time INTEGER DEFAULT 0,
        total_intent INTEGER DEFAULT 0,
        status INTEGER DEFAULT 1
      )`,
      `CREATE INDEX IF NOT EXISTS idx_xhs_intent_capture_date ON xhs_intent_comments(capture_date)`,
      `CREATE INDEX IF NOT EXISTS idx_xhs_intent_email_sent ON xhs_intent_comments(email_sent)`,
      `CREATE INDEX IF NOT EXISTS idx_xhs_intent_note_id ON xhs_intent_comments(note_id)`,
      `CREATE INDEX IF NOT EXISTS idx_xhs_intent_capture_time ON xhs_intent_comments(capture_time)`
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
    if (!db) {
      logger.warn('addIntentComment: 数据库未初始化，跳过');
      return false;
    }
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
        video_author, video_title, video_url, score, capture_time, email_sent, capture_date, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
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
        commentInfo.video_desc || commentInfo.video_info || commentInfo.video_title || '',
        commentInfo.video_url || '',
        commentInfo.score || 0,
        now, today,
        commentInfo.source || 'api'
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

/**
 * 简化别名：getLeads = 分页查询意向评论
 * @param {number} limit
 * @param {number} offset
 * @returns {Array}
 */
function getLeads(limit = 100, offset = 0) {
  return getRecentMatchesPage(offset, limit, {});
}

// ========== 小红书意向评论操作 ==========

function addXHSIntentComment(commentInfo) {
  try {
    if (!db) {
      logger.warn('addXHSIntentComment: 数据库未初始化，跳过');
      return false;
    }
    const now = Math.floor(Date.now() / 1000);
    const today = new Date().toISOString().slice(0, 10);
    const nickname = commentInfo.nickname || '';
    const commentText = commentInfo.text || commentInfo.comment_text || '';
    const userId = commentInfo.uid || commentInfo.user_id || '';

    if (commentInfo.comment_id) {
      const exists = queryOne('SELECT id FROM xhs_intent_comments WHERE comment_id=?', [commentInfo.comment_id]);
      if (exists) return false;
    }
    const dup = queryOne(
      'SELECT id FROM xhs_intent_comments WHERE user_id=? AND nickname=? AND comment_text=? AND capture_date=?',
      [userId, nickname, commentText, today]
    );
    if (dup) return false;

    const keywords = Array.isArray(commentInfo.matched_keywords)
      ? commentInfo.matched_keywords.join(',')
      : (commentInfo.matched_keywords || '');

    run(
      `INSERT OR IGNORE INTO xhs_intent_comments
       (note_id, comment_id, nickname, user_id, profile_url,
        comment_text, matched_keywords, comment_time, ip_label,
        note_author, note_title, note_url, score, capture_time, email_sent, capture_date, source, platform)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        commentInfo.note_id || commentInfo.aweme_id || '',
        commentInfo.comment_id || '',
        nickname, userId,
        commentInfo.profile_url || '',
        commentText, keywords,
        commentInfo.create_time || commentInfo.comment_time || now,
        commentInfo.ip_label || '',
        commentInfo.note_author || commentInfo.video_author || '',
        commentInfo.note_title || commentInfo.video_title || commentInfo.video_desc || '',
        commentInfo.note_url || commentInfo.video_url || '',
        commentInfo.score || 0,
        now, today,
        commentInfo.source || 'api',
        'xhs'
      ]
    );
    return true;
  } catch (e) {
    logger.error(`addXHSIntentComment 失败: ${e.message}`);
    return false;
  }
}

function getXHSStats() {
  const today = new Date().toISOString().slice(0, 10);
  const row = queryOne(`
    SELECT
      COUNT(*) AS total_comments,
      SUM(CASE WHEN capture_date = ? THEN 1 ELSE 0 END) AS today_matches,
      SUM(CASE WHEN capture_date = ? AND email_sent = 1 THEN 1 ELSE 0 END) AS today_emails
    FROM xhs_intent_comments
  `, [today, today]) || {};
  return {
    total_comments: row.total_comments || 0,
    today_matches: row.today_matches || 0,
    today_emails: row.today_emails || 0
  };
}

function getXHSRecentMatchesPage(offset = 0, limit = 50, filter = {}) {
  const where = [];
  const params = [];
  if (filter.date) { where.push('capture_date = ?'); params.push(filter.date); }
  if (filter.keyword) {
    where.push('(nickname LIKE ? OR comment_text LIKE ? OR note_title LIKE ?)');
    const k = `%${filter.keyword}%`;
    params.push(k, k, k);
  }
  const sql = `SELECT * FROM xhs_intent_comments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ? OFFSET ?`;
  return queryAll(sql, [...params, limit, offset]);
}

function getXHSMatchesCount(filter = {}) {
  const where = [];
  const params = [];
  if (filter.date) { where.push('capture_date = ?'); params.push(filter.date); }
  if (filter.keyword) {
    where.push('(nickname LIKE ? OR comment_text LIKE ? OR note_title LIKE ?)');
    const k = `%${filter.keyword}%`;
    params.push(k, k, k);
  }
  const row = queryOne(`SELECT COUNT(*) AS c FROM xhs_intent_comments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params);
  return row?.c || 0;
}

function clearXHSIntentComments() {
  run('DELETE FROM xhs_intent_comments');
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
  getLeads,
  saveToDisk,
  cleanupExpiredData,
  addXHSIntentComment,
  getXHSStats,
  getXHSRecentMatchesPage,
  getXHSMatchesCount,
  clearXHSIntentComments
};
