/**
 * 渲染进程主逻辑（重构版）
 *
 * 负责：标签页切换、IPC 事件绑定、UI 初始化
 *
 * 重构要点：
 *   - appendLog 不再按关键词过滤（系统消息统一收集）
 *   - onSearchLog / onMonitorLog 各自只挂一次（解耦：搜索面板只听 search，监控面板只听 monitor）
 *   - 错误通知通过统一通道，不依赖 alert()
 *   - 进度通过 'search-progress' / 'monitor-progress' 事件直接更新
 *   - 启动时一次 setInterval 拉取 stats
 */

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initLogListener();
  initStatsListener();
  initProgressListener();
  initErrorListener();
  initDatabaseListener();
  loadConfig();
});

// ========== 平台切换 ==========

window.switchPlatform = function(platform) {
  const douyinBtn = document.getElementById('btn-platform-douyin');
  const xhsBtn = document.getElementById('btn-platform-xhs');

  if (platform === 'xhs') {
    douyinBtn.classList.remove('active');
    xhsBtn.classList.add('active', 'active-xhs');
    // 通知主进程打开小红书窗口
    window.electronAPI.switchPlatform && window.electronAPI.switchPlatform('xhs');
  } else {
    xhsBtn.classList.remove('active', 'active-xhs');
    douyinBtn.classList.add('active');
    window.electronAPI.switchPlatform && window.electronAPI.switchPlatform('douyin');
  }
};

// ========== 通知组件（内嵌） ==========

const Toast = (() => {
  function ensureContainer() {
    let c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      c.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
      document.body.appendChild(c);
    }
    return c;
  }

  function show(msg, type = 'info', duration = 4000) {
    const c = ensureContainer();
    const el = document.createElement('div');
    const colors = {
      info: '#1976d2', success: '#2e7d32', warn: '#ed6c02', error: '#d32f2f'
    };
    el.style.cssText = `
      background:${colors[type] || colors.info};color:#fff;padding:10px 14px;
      border-radius:6px;font-size:13px;min-width:200px;max-width:420px;
      box-shadow:0 4px 12px rgba(0,0,0,0.2);pointer-events:auto;
      transition:opacity .3s;opacity:0;
    `;
    el.textContent = msg;
    c.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  return {
    info: (m) => show(m, 'info'),
    success: (m) => show(m, 'success'),
    warn: (m) => show(m, 'warn', 6000),
    error: (m) => show(m, 'error', 8000)
  };
})();

function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const tabId = `tab-${btn.dataset.tab}`;
      const target = document.getElementById(tabId);
      if (target) target.classList.add('active');
    });
  });
}

/**
 * 日志路由
 * 系统日志 → 运行日志面板
 * 任务日志 → 对应的任务面板（搜索/监控各自独立）
 */
function initLogListener() {
  // ========== 核心通道：所有模块的系统日志统一发送到 system-log ==========
  // 包含：Main主进程、StateMachine状态机、Scheduler调度器、Database数据库、
  //      SearchEngine搜索、VideoProcessor视频处理、CDP拦截器、HTTP服务等
  // 所有使用 logger.info/warn/error 的模块消息都通过此通道统一显示
  if (window.electronAPI.onSystemLog) {
    window.electronAPI.onSystemLog((data) => {
      if (!data) return;
      const { level, name, message } = data;
      const prefix = level === 'ERROR' ? `[${name} ❌]` : level === 'WARN' ? `[${name} ⚠️]` : `[${name}]`;
      appendLog(`${prefix} ${message}`, 'system');
    });
  }
  // 兼容：scheduler-log（scheduler可能还在用旧通道）
  window.electronAPI.onSchedulerLog && window.electronAPI.onSchedulerLog((msg) => appendLog(msg, 'system'));
  // 搜索任务的系统级消息（任务日志，与上面的系统日志互为补充）
  window.electronAPI.onSearchLog && window.electronAPI.onSearchLog((msg) => {
    if (typeof msg === 'string' && (msg.includes('🔔') || msg.includes('✅') || msg.includes('🛑') || msg.includes('⚠️') || msg.includes('启动') || msg.includes('完成') || msg.includes('停止') || msg.includes('异常'))) {
      appendLog(msg, 'system');
    } else if (typeof msg === 'string') {
      // 其他搜索任务日志（点击视频、处理评论等）也显示，方便排查
      appendLog(msg, 'system');
    }
  });
  // 监控任务的系统级消息
  window.electronAPI.onMonitorLog && window.electronAPI.onMonitorLog((msg) => {
    if (typeof msg === 'string') appendLog(msg, 'system');
  });
  // 推荐浏览的系统级消息
  window.electronAPI.onRecommendLog && window.electronAPI.onRecommendLog((msg) => {
    if (typeof msg === 'string') appendLog(msg, 'system');
  });
}

function initErrorListener() {
  window.electronAPI.onErrorNotify && window.electronAPI.onErrorNotify((msg) => {
    appendLog(`[严重错误] ${msg}`, 'error');
    Toast.error(msg);
  });
}

function initDatabaseListener() {
  window.electronAPI.onDatabaseError && window.electronAPI.onDatabaseError(({ message }) => {
    appendLog(`[数据库错误] ${message}`, 'error');
    Toast.error(`数据库错误: ${message}`);
  });
}

/**
 * 进度事件（来自 videoProcessor）
 */
function initProgressListener() {
  window.electronAPI.onSearchProgress && window.electronAPI.onSearchProgress((p) => {
    const ev = new CustomEvent('search-progress', { detail: p });
    document.dispatchEvent(ev);
  });
  window.electronAPI.onMonitorProgress && window.electronAPI.onMonitorProgress((p) => {
    const ev = new CustomEvent('monitor-progress', { detail: p });
    document.dispatchEvent(ev);
  });
}

function appendLog(msg, source = 'system') {
  const logContent = document.getElementById('log-content');
  if (!logContent) return;
  const entry = document.createElement('div');
  entry.className = `log-entry log-${source}`;

  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${msg}`;

  if (msg.includes('异常') || msg.includes('失败') || msg.includes('错误') || msg.includes('❌')) {
    entry.classList.add('log-error');
  } else if (msg.includes('警告') || msg.includes('⚠')) {
    entry.classList.add('log-warn');
  } else if (msg.includes('命中') || msg.includes('✅') || msg.includes('启动')) {
    entry.classList.add('log-success');
  }

  logContent.appendChild(entry);
  logContent.scrollTop = logContent.scrollHeight;

  while (logContent.children.length > 300) {
    logContent.removeChild(logContent.firstChild);
  }
}

function initStatsListener() {
  window.electronAPI.onStatsUpdated && window.electronAPI.onStatsUpdated((stats) => {
    updateStats(stats);
  });
  // 启动时主动拉一次
  window.electronAPI.getStats().then(updateStats).catch(() => {});
  // 兜底：每 5 秒拉一次
  setInterval(() => {
    window.electronAPI.getStats().then(updateStats).catch(() => {});
  }, 5000);
}

function updateStats(stats) {
  const todayEl = document.querySelector('#stat-today b');
  const totalEl = document.querySelector('#stat-total b');
  const emailEl = document.querySelector('#stat-emails b');
  const videoEl = document.querySelector('#stat-videos b');
  if (todayEl) todayEl.textContent = stats.today_matches || 0;
  if (totalEl) totalEl.textContent = stats.total_comments || 0;
  if (emailEl) emailEl.textContent = stats.today_emails || 0;
  if (videoEl) videoEl.textContent = stats.total_videos || 0;
}

async function loadConfig() {
  try {
    const cfg = await window.electronAPI.getConfig();
    if (cfg.email) {
      const e = cfg.email;
      document.getElementById('email-enable').checked = e.enable || false;
      document.getElementById('email-smtp').value = e.smtp_server || 'smtp.qq.com';
      document.getElementById('email-port').value = e.smtp_port || 465;
      document.getElementById('email-sender').value = e.sender || '';
      document.getElementById('email-auth').value = e.auth_code || '';
      document.getElementById('email-receivers').value = e.receivers || '';
    }
    if (cfg.wechat) {
      document.getElementById('wechat-enable').checked = cfg.wechat.enable || false;
      document.getElementById('wechat-url').value = cfg.wechat.webhook_url || '';
    }
    setTextarea('search-intent-kw', cfg.search_intent_keywords || []);
    setTextarea('search-garbage-kw', cfg.search_garbage_keywords || []);
  } catch (e) {
    appendLog(`加载配置失败: ${e.message}`);
  }
}

function setTextarea(id, arr) {
  const el = document.getElementById(id);
  if (el && Array.isArray(arr)) el.value = arr.join('\n');
}

function getTextarea(id) {
  const el = document.getElementById(id);
  if (!el) return [];
  return el.value.split('\n').map(s => s.trim()).filter(Boolean);
}

window.Toast = Toast;
