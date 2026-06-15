/**
 * 渲染进程主逻辑
 * 负责：标签页切换、IPC 事件绑定、UI 初始化
 */

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initLogListener();
  initStatsListener();
  initErrorListener();
  loadConfig();
});

/**
 * 初始化标签页切换
 */
function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const tabId = `tab-${btn.dataset.tab}`;
      document.getElementById(tabId).classList.add('active');
    });
  });
}

/**
 * 初始化日志监听
 * 接收主进程发来的日志消息并显示
 */
function initLogListener() {
  window.electronAPI.onSearchLog((msg) => appendLog(msg));
  window.electronAPI.onMonitorLog((msg) => appendLog(msg));
}

/**
 * 初始化错误通知监听
 * 主进程发来的严重错误会在日志面板高亮显示
 */
function initErrorListener() {
  window.electronAPI.onErrorNotify((msg) => {
    appendLog(`[严重错误] ${msg}`);
    // 在日志面板顶部插入醒目错误提示
    const logContent = document.getElementById('log-content');
    if (logContent) {
      const errDiv = document.createElement('div');
      errDiv.style.cssText = 'background:#d32f2f;color:#fff;padding:8px 10px;margin-bottom:4px;border-radius:4px;font-size:12px;';
      errDiv.textContent = `⚠ ${msg}`;
      logContent.insertBefore(errDiv, logContent.firstChild);
      // 30 秒后自动移除
      setTimeout(() => { if (errDiv.parentNode) errDiv.remove(); }, 30000);
    }
  });
}

/**
 * 追加日志到日志面板
 * @param {string} msg - 日志消息
 */
function appendLog(msg) {
  const logContent = document.getElementById('log-content');
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${msg}`;

  if (msg.includes('异常') || msg.includes('失败') || msg.includes('错误')) {
    entry.classList.add('log-error');
  } else if (msg.includes('警告') || msg.includes('⚠')) {
    entry.classList.add('log-warn');
  }

  logContent.appendChild(entry);
  logContent.scrollTop = logContent.scrollHeight;

  // 限制日志条数
  while (logContent.children.length > 200) {
    logContent.removeChild(logContent.firstChild);
  }
}

/**
 * 初始化统计数据监听
 */
function initStatsListener() {
  window.electronAPI.onStatsUpdated((stats) => {
    updateStats(stats);
  });

  // 定期刷新统计
  setInterval(async () => {
    try {
      const stats = await window.electronAPI.getStats();
      updateStats(stats);
    } catch (e) {}
  }, 5000);
}

/**
 * 更新头部统计显示
 * @param {Object} stats - 统计数据
 */
function updateStats(stats) {
  const todayEl = document.querySelector('#stat-today b');
  const totalEl = document.querySelector('#stat-total b');
  if (todayEl) todayEl.textContent = stats.today_matches || 0;
  if (totalEl) totalEl.textContent = stats.total_comments || 0;
}

/**
 * 加载配置到 UI
 */
async function loadConfig() {
  try {
    const cfg = await window.electronAPI.getConfig();

    // 邮件设置
    if (cfg.email) {
      document.getElementById('email-enable').checked = cfg.email.enable || false;
      document.getElementById('email-smtp').value = cfg.email.smtp_server || 'smtp.qq.com';
      document.getElementById('email-port').value = cfg.email.smtp_port || 465;
      document.getElementById('email-sender').value = cfg.email.sender || '';
      document.getElementById('email-auth').value = cfg.email.auth_code || '';
      document.getElementById('email-receivers').value = cfg.email.receivers || '';
    }

    // 企微设置
    if (cfg.wechat) {
      document.getElementById('wechat-enable').checked = cfg.wechat.enable || false;
      document.getElementById('wechat-url').value = cfg.wechat.webhook_url || '';
    }

    // 关键词
    setTextarea('search-intent-kw', cfg.search_intent_keywords || []);
    setTextarea('search-garbage-kw', cfg.search_garbage_keywords || []);
  } catch (e) {
    appendLog(`加载配置失败: ${e.message}`);
  }
}

/**
 * 设置 textarea 的值（数组转换行分隔字符串）
 * @param {string} id - textarea 元素 ID
 * @param {Array} arr - 关键词数组
 */
function setTextarea(id, arr) {
  const el = document.getElementById(id);
  if (el && Array.isArray(arr)) {
    el.value = arr.join('\n');
  }
}

/**
 * 从 textarea 获取关键词数组
 * @param {string} id - textarea 元素 ID
 * @returns {Array} 关键词数组
 */
function getTextarea(id) {
  const el = document.getElementById(id);
  if (!el) return [];
  return el.value.split('\n').map(s => s.trim()).filter(Boolean);
}
