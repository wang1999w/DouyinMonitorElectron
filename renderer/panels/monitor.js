/**
 * 博主监控面板
 * 负责：博主列表管理、监控启停控制、监控结果显示
 * 使用 HTML 模态框替代 prompt() 实现博主添加
 */

(function () {
  let selectedBloggerIdx = -1;
  let currentBloggers = [];

  function initMonitor() {
    document.getElementById('btn-monitor-add').addEventListener('click', showAddBloggerModal);
    document.getElementById('btn-monitor-del').addEventListener('click', delBlogger);
    document.getElementById('btn-monitor-start').addEventListener('click', startMonitor);
    document.getElementById('btn-monitor-stop').addEventListener('click', stopMonitor);
    document.getElementById('btn-save-monitor-kw').addEventListener('click', saveMonitorKeywords);

    window.electronAPI.onMonitorLog((msg) => updateMonitorStatus(msg));
    window.electronAPI.onMonitorResult((result) => addMonitorResult(result));

    loadBloggerList();
  }

  async function loadBloggerList() {
    try {
      const cfg = await window.electronAPI.getConfig();
      currentBloggers = cfg.monitor_bloggers || [];
      renderBloggerList();
    } catch (e) {}
  }

  function renderBloggerList() {
    const container = document.getElementById('blogger-list');
    container.innerHTML = '';

    if (currentBloggers.length === 0) {
      container.innerHTML = '<div style="padding:8px;color:#999;font-size:12px;">暂无博主，点击"添加博主"开始</div>';
      return;
    }

    currentBloggers.forEach((b, i) => {
      const item = document.createElement('div');
      item.className = 'blogger-item' + (i === selectedBloggerIdx ? ' selected' : '');
      const uid = (b.sec_uid || '').substring(0, 12);
      const times = (b.time_ranges || []).join(', ') || '全天';
      item.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${escapeHtml(b.nickname || '未命名')}</div>
          <div style="font-size:10px;color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(uid)}...</div>
          <div style="font-size:10px;color:#888;">时段: ${escapeHtml(times)}</div>
        </div>
        <span style="font-size:11px;color:${b.status === 1 ? '#34a853' : '#999'};">${b.status === 1 ? '启用' : '暂停'}</span>
      `;
      item.addEventListener('click', () => {
        selectedBloggerIdx = i;
        renderBloggerList();
      });
      container.appendChild(item);
    });
  }

  /**
   * 显示添加博主模态框
   * 打开时隐藏 BrowserView，避免模态框被遮挡
   */
  async function showAddBloggerModal() {
    await window.electronAPI.hideDouyinView();
    let modal = document.getElementById('blogger-modal');
    if (!modal) {
      modal = createBloggerModal();
      document.body.appendChild(modal);
    }
    document.getElementById('bm-nickname').value = '';
    document.getElementById('bm-secuid').value = '';
    document.getElementById('bm-times').value = '09:00-12:00\n14:00-18:00';
    document.getElementById('bm-days').value = '7';
    modal.style.display = 'flex';
  }

  /**
   * 关闭模态框，恢复 BrowserView
   */
  async function closeModal() {
    const modal = document.getElementById('blogger-modal');
    if (modal) modal.style.display = 'none';
    await window.electronAPI.showDouyinView();
  }

  /**
   * 创建博主添加/编辑模态框 DOM
   */
  function createBloggerModal() {
    const modal = document.createElement('div');
    modal.id = 'blogger-modal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;justify-content:center;align-items:center;';

    modal.innerHTML = `
      <div style="background:#fff;border-radius:8px;padding:20px;width:420px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
        <h3 style="margin:0 0 16px;font-size:15px;color:#333;">添加监控博主</h3>

        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:12px;color:#666;margin-bottom:4px;">博主昵称</label>
          <input type="text" id="bm-nickname" placeholder="如：张三" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box;">
        </div>

        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:12px;color:#666;margin-bottom:4px;">博主 sec_uid <span style="color:#999;">（从主页链接 user/ 后复制）</span></label>
          <input type="text" id="bm-secuid" placeholder="MS4wLjABAAAA..." style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box;">
        </div>

        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:12px;color:#666;margin-bottom:4px;">监控时段 <span style="color:#999;">（每行一个，如 09:00-09:40）</span></label>
          <textarea id="bm-times" rows="4" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box;font-family:monospace;resize:vertical;">09:00-12:00
14:00-18:00</textarea>
        </div>

        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:12px;color:#666;margin-bottom:4px;">作品日期筛选</label>
          <select id="bm-days" style="padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;">
            <option value="1">1天内</option>
            <option value="7" selected>7天内</option>
          </select>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="bm-cancel" style="padding:7px 16px;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer;font-size:13px;">取消</button>
          <button id="bm-save" style="padding:7px 16px;border:none;background:#1a73e8;color:#fff;border-radius:4px;cursor:pointer;font-size:13px;">保存</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('#bm-cancel').addEventListener('click', () => {
      closeModal();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    modal.querySelector('#bm-save').addEventListener('click', async () => {
      const nickname = document.getElementById('bm-nickname').value.trim();
      const secUid = document.getElementById('bm-secuid').value.trim();
      const timesStr = document.getElementById('bm-times').value.trim();
      const days = parseInt(document.getElementById('bm-days').value) || 7;

      if (!secUid) {
        alert('请填写博主 sec_uid');
        return;
      }
      if (!timesStr) {
        alert('请至少填写一个监控时段');
        return;
      }

      const timeRanges = timesStr.split('\n').map(s => s.trim()).filter(Boolean);

      const blogger = {
        sec_uid: secUid,
        nickname: nickname || '未命名',
        time_ranges: timeRanges,
        date_mode: 'recent_days',
        date_value: days,
        status: 1
      };

      await window.electronAPI.addBlogger(blogger);
      closeModal();
      loadBloggerList();
    });

    return modal;
  }

  async function delBlogger() {
    if (selectedBloggerIdx < 0) {
      alert('请先选择一个博主');
      return;
    }
    if (!confirm('确定删除选中的博主吗？')) return;

    await window.electronAPI.delBlogger(selectedBloggerIdx);
    selectedBloggerIdx = -1;
    loadBloggerList();
  }

  async function startMonitor() {
    const cfg = await window.electronAPI.getConfig();
    if (!cfg.monitor_bloggers || cfg.monitor_bloggers.length === 0) {
      alert('请先添加监控博主');
      return;
    }
    setMonitorRunning(true);
    await window.electronAPI.startMonitor();
  }

  async function stopMonitor() {
    await window.electronAPI.stopMonitor();
    setMonitorRunning(false);
  }

  async function saveMonitorKeywords() {
    const cfg = await window.electronAPI.getConfig();
    cfg.monitor_intent_keywords = getTextarea('monitor-intent-kw');
    cfg.monitor_garbage_keywords = getTextarea('monitor-garbage-kw');
    await window.electronAPI.saveConfig(cfg);
    alert('监控关键词已保存');
  }

  function setMonitorRunning(running) {
    document.getElementById('btn-monitor-start').disabled = running;
    document.getElementById('btn-monitor-stop').disabled = !running;
  }

  function updateMonitorStatus(msg) {
    if (msg.includes('已停止')) setMonitorRunning(false);
  }

  function addMonitorResult(result) {
    const container = document.getElementById('monitor-results');
    const item = document.createElement('div');
    item.className = 'result-item';
    const score = result.score || 0;
    const scoreClass = score >= 10 ? 'score-high' : score >= 5 ? 'score-mid' : 'score-low';
    item.innerHTML = `
      <div class="ri-header">
        <span class="ri-nick">${escapeHtml(result.nickname || '')}</span>
        <span class="ri-score ${scoreClass}">${score}分</span>
      </div>
      <div class="ri-comment">${escapeHtml(result.comment_text || '')}</div>
      <div class="ri-meta">关键词: ${escapeHtml(result.matched_keywords || '')} | 博主: ${escapeHtml(result.video_author || '')}</div>
    `;
    container.insertBefore(item, container.firstChild);
    while (container.children.length > 200) container.removeChild(container.lastChild);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function getTextarea(id) {
    const el = document.getElementById(id);
    if (!el) return [];
    return el.value.split('\n').map(s => s.trim()).filter(Boolean);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMonitor);
  } else {
    initMonitor();
  }
})();
