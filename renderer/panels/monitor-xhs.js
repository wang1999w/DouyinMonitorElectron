/**
 * 小红书博主监控面板
 */

(function () {
  let selectedBloggerIdx = -1;
  let currentBloggers = [];
  let editMode = false;

  function initMonitor() {
    document.getElementById('xhs-btn-monitor-add').addEventListener('click', () => showBloggerModal(false));
    document.getElementById('xhs-btn-monitor-edit').addEventListener('click', () => showBloggerModal(true));
    document.getElementById('xhs-btn-monitor-del').addEventListener('click', delBlogger);
    document.getElementById('xhs-btn-monitor-start').addEventListener('click', startMonitor);
    document.getElementById('xhs-btn-monitor-stop').addEventListener('click', stopMonitor);

    window.xhsAPI.onXhsMonitorLog && window.xhsAPI.onXhsMonitorLog((msg) => {
      updateStatus(msg);
      appendTaskLog(msg);
    });
    window.xhsAPI.onXhsMonitorResult && window.xhsAPI.onXhsMonitorResult((result) => {
      addMonitorResult(result);
    });
    window.xhsAPI.onXhsMonitorProgress && window.xhsAPI.onXhsMonitorProgress((p) => {
      if (p && typeof p.matchedTotal === 'number') {
        const el = document.getElementById('xhs-monitor-status');
        if (el) el.textContent = `监控已命中 ${p.matchedTotal} 条`;
      }
    });

    loadBloggerList();
  }

  async function loadBloggerList() {
    try {
      const cfg = await window.xhsAPI.getConfig();
      currentBloggers = cfg.xhs_monitor_bloggers || [];
      renderBloggerList();
    } catch (e) {}
  }

  function renderBloggerList() {
    const container = document.getElementById('xhs-blogger-list');
    container.innerHTML = '';
    if (currentBloggers.length === 0) {
      container.innerHTML = '<div style="padding:8px;color:#999;font-size:12px;">暂无博主，点击"添加博主"开始</div>';
      return;
    }
    currentBloggers.forEach((b, i) => {
      const item = document.createElement('div');
      item.className = 'blogger-item' + (i === selectedBloggerIdx ? ' selected' : '');
      const times = (b.trigger_times || []).join(', ') || '未设置';
      const intentCount = (b.intent_keywords || []).length;
      item.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13px;">${escapeHtml(b.nickname || '未命名')}</div>
          <div style="font-size:10px;color:#888;margin-top:2px;">触发: ${escapeHtml(times)} | 意向词: ${intentCount}个</div>
        </div>
        <span style="font-size:11px;color:${b.status === 1 ? '#34a853' : '#999'};">${b.status === 1 ? '启用' : '暂停'}</span>
      `;
      item.addEventListener('click', () => { selectedBloggerIdx = i; renderBloggerList(); });
      container.appendChild(item);
    });
  }

  async function showBloggerModal(edit) {
    if (edit && selectedBloggerIdx < 0) { window.Toast && window.Toast.warn('请先选中博主'); return; }
    editMode = edit;
    // 隐藏BrowserView防止弹窗被遮挡
    await window.xhsAPI.xhsHideView();
    let modal = document.getElementById('xhs-blogger-modal');
    if (!modal) { modal = createBloggerModal(); document.body.appendChild(modal); }

    if (edit) {
      const b = currentBloggers[selectedBloggerIdx];
      document.getElementById('xhs-bm-nickname').value = b.nickname || '';
      document.getElementById('xhs-bm-userid').value = b.user_id || '';
      document.getElementById('xhs-bm-userid').disabled = true;
      document.getElementById('xhs-bm-times').value = (b.trigger_times || []).join('\n');
      document.getElementById('xhs-bm-intent-kw').value = (b.intent_keywords || []).join('\n');
      document.getElementById('xhs-bm-garbage-kw').value = (b.garbage_keywords || []).join('\n');
      document.getElementById('xhs-bm-comment-hours').value = b.comment_hours || 60;
      document.getElementById('xhs-bm-status').checked = b.status !== 0;
    } else {
      document.getElementById('xhs-bm-nickname').value = '';
      document.getElementById('xhs-bm-userid').value = '';
      document.getElementById('xhs-bm-userid').disabled = false;
      document.getElementById('xhs-bm-times').value = '09:00\n14:00';
      document.getElementById('xhs-bm-intent-kw').value = '';
      document.getElementById('xhs-bm-garbage-kw').value = '';
      document.getElementById('xhs-bm-comment-hours').value = 60;
      document.getElementById('xhs-bm-status').checked = true;
    }
    modal.style.display = 'flex';
  }

  function createBloggerModal() {
    const modal = document.createElement('div');
    modal.id = 'xhs-blogger-modal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;justify-content:center;align-items:center;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:8px;padding:20px;width:500px;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
        <h3 style="margin:0 0 14px;font-size:15px;color:#333;">添加小红书博主</h3>
        <div style="display:flex;gap:12px;margin-bottom:10px;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">博主昵称</label>
            <input type="text" id="xhs-bm-nickname" placeholder="如：张三" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;">
          </div>
          <div style="flex:2;">
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">user_id <span style="color:#999;">（主页链接 profile/ 后）</span></label>
            <input type="text" id="xhs-bm-userid" placeholder="如：5f8a3b2c..." style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;">
          </div>
        </div>
        <div style="margin-bottom:10px;">
          <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">触发时间点（每行一个）</label>
          <textarea id="xhs-bm-times" rows="2" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;resize:vertical;">09:00
14:00</textarea>
        </div>
        <div style="margin-bottom:10px;">
          <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">评论时效（分钟）</label>
          <input type="number" id="xhs-bm-comment-hours" value="60" min="1" style="width:80px;padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:12px;color:#666;"><input type="checkbox" id="xhs-bm-status" checked> 启用监控</label>
        </div>
        <div style="display:flex;gap:12px;margin-bottom:10px;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">意向关键词</label>
            <textarea id="xhs-bm-intent-kw" rows="4" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;resize:vertical;"></textarea>
          </div>
          <div style="flex:1;">
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">垃圾关键词</label>
            <textarea id="xhs-bm-garbage-kw" rows="4" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;resize:vertical;"></textarea>
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="xhs-bm-cancel" style="padding:6px 14px;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer;font-size:12px;">取消</button>
          <button id="xhs-bm-save" style="padding:6px 14px;border:none;background:#e74c3c;color:#fff;border-radius:4px;cursor:pointer;font-size:12px;">保存</button>
        </div>
      </div>
    `;

    modal.querySelector('#xhs-bm-cancel').addEventListener('click', () => { modal.style.display = 'none'; window.xhsAPI.xhsShowView(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) { modal.style.display = 'none'; window.xhsAPI.xhsShowView(); } });

    modal.querySelector('#xhs-bm-save').addEventListener('click', async () => {
      const nickname = document.getElementById('xhs-bm-nickname').value.trim();
      const userId = document.getElementById('xhs-bm-userid').value.trim();
      const timesStr = document.getElementById('xhs-bm-times').value.trim();
      const intentStr = document.getElementById('xhs-bm-intent-kw').value.trim();
      const garbageStr = document.getElementById('xhs-bm-garbage-kw').value.trim();
      const commentHours = parseInt(document.getElementById('xhs-bm-comment-hours').value) || 60;
      const status = document.getElementById('xhs-bm-status').checked ? 1 : 0;

      if (!userId) { window.Toast && window.Toast.warn('请填写 user_id'); return; }

      let result;
      if (editMode) {
        result = await window.xhsAPI.xhsUpdateBlogger({
          userId, updates: {
            nickname: nickname || '未命名',
            trigger_times: timesStr.split('\n').map(s => s.trim()).filter(Boolean),
            intent_keywords: intentStr ? intentStr.split('\n').map(s => s.trim()).filter(Boolean) : [],
            garbage_keywords: garbageStr ? garbageStr.split('\n').map(s => s.trim()).filter(Boolean) : [],
            comment_hours: commentHours, status
          }
        });
      } else {
        result = await window.xhsAPI.xhsAddBlogger({
          user_id: userId,
          nickname: nickname || '未命名',
          trigger_times: timesStr.split('\n').map(s => s.trim()).filter(Boolean),
          intent_keywords: intentStr ? intentStr.split('\n').map(s => s.trim()).filter(Boolean) : [],
          garbage_keywords: garbageStr ? garbageStr.split('\n').map(s => s.trim()).filter(Boolean) : [],
          comment_hours: commentHours, status
        });
      }

      if (result && result.success) {
        window.Toast && window.Toast.success(editMode ? '博主已更新' : '博主已添加');
      } else {
        window.Toast && window.Toast.error((result && result.error) || '保存失败');
      }
      modal.style.display = 'none';
      window.xhsAPI.xhsShowView();
      loadBloggerList();
    });

    return modal;
  }

  async function delBlogger() {
    if (selectedBloggerIdx < 0) { window.Toast && window.Toast.warn('请先选择博主'); return; }
    const target = currentBloggers[selectedBloggerIdx];
    await window.xhsAPI.xhsDelBlogger(target ? target.user_id : selectedBloggerIdx);
    selectedBloggerIdx = -1;
    loadBloggerList();
  }

  async function startMonitor() {
    const cfg = await window.xhsAPI.getConfig();
    if (!cfg.xhs_monitor_bloggers || cfg.xhs_monitor_bloggers.length === 0) {
      window.Toast && window.Toast.warn('请先添加监控博主');
      return;
    }
    setMonitorRunning(true);
    await window.xhsAPI.xhsStartMonitor();
  }

  async function stopMonitor() {
    await window.xhsAPI.xhsStopMonitor();
    setMonitorRunning(false);
  }

  function setMonitorRunning(running) {
    document.getElementById('xhs-btn-monitor-start').disabled = running;
    document.getElementById('xhs-btn-monitor-stop').disabled = !running;
  }

  function addMonitorResult(result) {
    const container = document.getElementById('xhs-blogger-list');
    if (!container) return;
    // 在博主列表下方显示命中结果
    let resultArea = document.getElementById('xhs-monitor-results');
    if (!resultArea) {
      resultArea = document.createElement('div');
      resultArea.id = 'xhs-monitor-results';
      resultArea.style.cssText = 'max-height:200px;overflow-y:auto;margin-top:8px;';
      container.parentNode.insertBefore(resultArea, container.nextSibling);
    }
    const item = document.createElement('div');
    item.className = 'result-item';
    const score = result.score || 0;
    const scoreClass = score >= 10 ? 'score-high' : score >= 5 ? 'score-mid' : 'score-low';
    const keywords = Array.isArray(result.matched_keywords) ? result.matched_keywords.join(',') : (result.matched_keywords || '');
    item.innerHTML = `
      <div class="ri-header">
        <span class="ri-nick">${escapeHtml(result.nickname || '')}</span>
        <span class="ri-score ${scoreClass}">${score}分</span>
      </div>
      <div class="ri-comment">${escapeHtml(result.text || result.comment_text || '')}</div>
      <div class="ri-meta">意向词: ${escapeHtml(keywords)}</div>
    `;
    resultArea.insertBefore(item, resultArea.firstChild);
    while (resultArea.children.length > 100) resultArea.removeChild(resultArea.lastChild);
  }

  function updateStatus(msg) {
    const el = document.getElementById('xhs-monitor-status');
    if (el) el.textContent = msg;
    if (msg.includes('停止') || msg.includes('完成')) setMonitorRunning(false);
  }

  function appendTaskLog(msg) {
    const el = document.getElementById('xhs-monitor-task-log');
    if (!el) return;
    const ts = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.style.cssText = 'white-space:pre-wrap;word-break:break-all;padding:1px 0;';
    if (msg.includes('异常') || msg.includes('失败')) line.style.color = '#f44336';
    else if (msg.includes('完成') || msg.includes('✅')) line.style.color = '#4caf50';
    line.textContent = `[${ts}] ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 300) el.removeChild(el.firstChild);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMonitor);
  } else {
    initMonitor();
  }
})();
