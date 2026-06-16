/**
 * 小红书渲染进程主逻辑
 */

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initStatsListener();
  loadConfig();
});

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
    const colors = { info: '#e74c3c', success: '#2e7d32', warn: '#ed6c02', error: '#d32f2f' };
    el.style.cssText = `background:${colors[type] || colors.info};color:#fff;padding:10px 14px;border-radius:6px;font-size:13px;min-width:200px;max-width:420px;box-shadow:0 4px 12px rgba(0,0,0,0.2);pointer-events:auto;transition:opacity .3s;opacity:0;`;
    el.textContent = msg;
    c.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, duration);
  }
  return { info: (m) => show(m, 'info'), success: (m) => show(m, 'success'), warn: (m) => show(m, 'warn', 6000), error: (m) => show(m, 'error', 8000) };
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

function initStatsListener() {
  window.xhsAPI.onXhsStatsUpdated && window.xhsAPI.onXhsStatsUpdated((stats) => {
    updateStats(stats);
  });
  window.xhsAPI.xhsGetStats && window.xhsAPI.xhsGetStats().then(updateStats).catch(() => {});
  setInterval(() => {
    window.xhsAPI.xhsGetStats && window.xhsAPI.xhsGetStats().then(updateStats).catch(() => {});
  }, 5000);
}

function updateStats(stats) {
  const todayEl = document.querySelector('#xhs-stat-today b');
  const totalEl = document.querySelector('#xhs-stat-total b');
  if (todayEl) todayEl.textContent = stats.today_matches || 0;
  if (totalEl) totalEl.textContent = stats.total_comments || 0;
}

async function loadConfig() {
  try {
    const cfg = await window.xhsAPI.getConfig();
    setTextarea('xhs-intent-kw', cfg.xhs_search_intent_keywords || []);
    setTextarea('xhs-garbage-kw', cfg.xhs_search_garbage_keywords || []);
  } catch (e) {}
}

function setTextarea(id, arr) {
  const el = document.getElementById(id);
  if (el && Array.isArray(arr)) el.value = arr.join('\n');
}

window.Toast = Toast;
