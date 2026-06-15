/**
 * 配置管理模块
 * 负责：配置文件读写、备份、导入导出
 * 使用 JSON 文件存储，支持自动备份
 */

const fs = require('fs');
const path = require('path');

/** 配置文件路径 */
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const BACKUP_DIR = path.join(__dirname, '..', 'config_backups');

/** 默认配置 */
const DEFAULT_CONFIG = {
  // 搜索关键词（设置面板管理，搜索模块使用）
  search_intent_keywords: ['咨询', '多少钱', '价格', '了解', '想了解', '推荐'],
  search_garbage_keywords: ['666', '关注', '互粉', '点赞', '好看'],
  // 监控博主列表（每个博主有独立的 intent/garbage keywords + time_ranges）
  monitor_bloggers: [],
  // 搜索定时任务
  search_schedule: { enable: false, interval: 30, unit: 60, hours: '08:00-22:00' },
  email: { enable: false, smtp_server: 'smtp.qq.com', smtp_port: 465, sender: '', auth_code: '', receivers: '' },
  wechat: { enable: false, webhook_url: '' }
};

/**
 * 博主配置模板
 * {
 *   sec_uid: string,          // 博主主页 ID
 *   nickname: string,         // 博主昵称
 *   trigger_times: string[],  // 触发时间点 ["09:00", "14:00"]（到点自动执行一次）
 *   intent_keywords: string[],// 该博主的意向关键词
 *   garbage_keywords: string[],// 该博主的垃圾关键词
 *   date_value: number,       // 作品日期筛选（天）
 *   status: number            // 1=启用 0=暂停
 * }
 */

/**
 * 加载配置文件
 * 如果配置文件不存在或解析失败，返回默认配置
 * @returns {Object} 配置对象
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const cfg = JSON.parse(raw);
      // 合并默认值（补全缺失字段）
      return mergeDefaults(cfg);
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/**
 * 保存配置文件
 * 保存前自动备份旧配置
 * @param {Object} cfg - 配置对象
 */
function saveConfig(cfg) {
  autoBackup(cfg);
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

/**
 * 合并默认值（补全缺失字段，不覆盖已有值）
 * @param {Object} cfg - 用户配置
 * @returns {Object} 补全后的配置
 */
function mergeDefaults(cfg) {
  const result = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  for (const key of Object.keys(result)) {
    if (!(key in cfg)) {
      continue;
    }
    if (typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
      result[key] = { ...result[key], ...cfg[key] };
    } else {
      result[key] = cfg[key];
    }
  }
  // 保留默认配置中没有的额外字段
  for (const key of Object.keys(cfg)) {
    if (!(key in result)) {
      result[key] = cfg[key];
    }
  }
  return result;
}

/**
 * 自动备份当前配置
 * 保留最近 20 个备份
 */
function autoBackup(newCfg) {
  if (!fs.existsSync(CONFIG_PATH)) return;

  try {
    const oldRaw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const newRaw = JSON.stringify(newCfg, null, 2);
    if (oldRaw === newRaw) return;
  } catch (e) {
    return;
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `config_${ts}.json`);
  fs.copyFileSync(CONFIG_PATH, backupPath);

  // 清理超过 20 个的旧备份
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('config_') && f.endsWith('.json'))
    .sort();
  while (backups.length > 20) {
    fs.unlinkSync(path.join(BACKUP_DIR, backups.shift()));
  }
}

/**
 * 列出所有配置备份
 * @returns {Array<Object>} 备份列表 [{ name, path, size }]
 */
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('config_') && f.endsWith('.json'))
    .sort()
    .reverse()
    .map(f => {
      const p = path.join(BACKUP_DIR, f);
      return { name: f, path: p, size: fs.statSync(p).size };
    });
}

/**
 * 从备份恢复配置
 * @param {string} backupPath - 备份文件路径
 * @returns {Object} 恢复后的配置
 */
function restoreConfig(backupPath) {
  const raw = fs.readFileSync(backupPath, 'utf-8');
  const cfg = JSON.parse(raw);
  saveConfig(cfg);
  return cfg;
}

module.exports = {
  loadConfig,
  saveConfig,
  listBackups,
  restoreConfig,
  DEFAULT_CONFIG
};
