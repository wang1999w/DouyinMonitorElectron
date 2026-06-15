/**
 * 博主监控面板
 * 重构：每个博主独立意向/垃圾关键词
 * 时段设置：设定时间节点，到时间自动执行
 * 优先级：监控触发时暂停搜索，完成后恢复
 */

(function () {
  let selectedBloggerIdx = -1;
  let currentBloggers = [];

  function initMonitor() {
    document.getElementById('btn-monitor-add').addEventListener('click', showAddBloggerModal);
    document.getElementById('btn-monitor-del').addEventListener('click', delBlogger);
    document.getElementById('btn-monitor-start').addEventListener('click', startMonitor);
    document.getElementById('btn-monitor-stop').addEventListener('click', stopMonitor);

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
      const times = (b.trigger_times || []).join(', ') || '未设置';
      const intentCount = (b.intent_keywords || []).length;
      const garbCount = (b.garbage_keywords || []).length;
      item.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13px;">${escapeHtml(b.nickname || '未命名')}</div>
          <div style="font-size:10px;color:#888;margin-top:2px;">触发: ${escapeHtml(times)} | 意向词: ${intentCount}个 | 垃圾词: ${garbCount}个</div>
        </div>
        <span style="font-size:11px;color:${b.status === 1 ? '#34a853' : '#999'};">${b.status === 1 ? '启用' : '暂停'}</span>
      `;
      item.addEventListener('click', () => { selectedBloggerIdx = i; renderBloggerList(); });
      container.appendChild(item);
    });
  }

  /**
   * 显示添加博主模态框
   * 包含：昵称、sec_uid、时段、意向关键词、垃圾关键词
   */
  async function showAddBloggerModal() {
    await window.electronAPI.hideDouyinView();
    let modal = document.getElementById('blogger-modal');
    if (!modal) { modal = createBloggerModal(); document.body.appendChild(modal); }
    // 清空表单
    document.getElementById('bm-nickname').value = '';
    document.getElementById('bm-secuid').value = '';
    document.getElementById('bm-times').value = '09:00\n14:00';
    document.getElementById('bm-intent-kw').value = '';
    document.getElementById('bm-garbage-kw').value = '';
    document.getElementById('bm-days').value = '7';
    modal.style.display = 'flex';
  }

  function createBloggerModal() {
    const modal = document.createElement('div');
    modal.id = 'blogger-modal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;justify-content:center;align-items:center;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:8px;padding:20px;width:500px;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
        <h3 style="margin:0 0 14px;font-size:15px;color:#333;">添加监控博主</h3>

        <div style="display:flex;gap:12px;margin-bottom:10px;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">博主昵称</label>
            <input type="text" id="bm-nickname" placeholder="如：张三" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;">
          </div>
          <div style="flex:2;">
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">sec_uid <span style="color:#999;">（主页链接 user/ 后）</span></label>
            <input type="text" id="bm-secuid" placeholder="MS4wLjABAAAA..." style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;">
          </div>
        </div>

        <div style="margin-bottom:10px;">
          <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">触发时间点 <span style="color:#999;">（每行一个，如 09:00，到点自动执行一次监控）</span></label>
          <textarea id="bm-times" rows="2" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;font-family:monospace;resize:vertical;">09:00
14:00</textarea>
        </div>

        <div style="display:flex;gap:12px;margin-bottom:10px;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">评论时效 <span style="color:#999;">（只采集这个时间内的评论）</span></label>
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="number" id="bm-comment-hours" value="60" min="1" max="1440" style="width:60px;padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
              <select id="bm-comment-unit" style="padding:5px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                <option value="1">分钟</option>
                <option value="60">小时</option>
              </select>
            </div>
          </div>
          <div style="flex:1;">
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">作品日期筛选</label>
            <select id="bm-days" style="padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
              <option value="1">1天内</option>
              <option value="7" selected>7天内</option>
              <option value="15">15天内</option>
              <option value="30">30天内</option>
            </select>
          </div>
        </div>

        <div style="display:flex;gap:12px;margin-bottom:10px;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">意向关键词 <span style="color:#999;">（每行一个）</span></label>
            <textarea id="bm-intent-kw" rows="4" placeholder="咨询\n多少钱\n价格\n想了解" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;resize:vertical;"></textarea>
          </div>
          <div style="flex:1;">
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">垃圾关键词 <span style="color:#999;">（每行一个）</span></label>
            <textarea id="bm-garbage-kw" rows="4" placeholder="666\n关注\n互粉\n点赞" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;resize:vertical;"></textarea>
          </div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="bm-cancel" style="padding:6px 14px;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer;font-size:12px;">取消</button>
          <button id="bm-save" style="padding:6px 14px;border:none;background:#1a73e8;color:#fff;border-radius:4px;cursor:pointer;font-size:12px;">保存</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('#bm-cancel').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    modal.querySelector('#bm-save').addEventListener('click', async () => {
      const nickname = document.getElementById('bm-nickname').value.trim();
      const secUid = document.getElementById('bm-secuid').value.trim();
      const timesStr = document.getElementById('bm-times').value.trim();
      const intentStr = document.getElementById('bm-intent-kw').value.trim();
      const garbageStr = document.getElementById('bm-garbage-kw').value.trim();
      const days = parseInt(document.getElementById('bm-days').value) || 7;
      const commentHours = (parseInt(document.getElementById('bm-comment-hours').value) || 60) * (parseInt(document.getElementById('bm-comment-unit').value) || 1);

      if (!secUid) { alert('请填写博主 sec_uid'); return; }
      if (!timesStr) { alert('请至少填写一个触发时间点'); return; }

      const blogger = {
        sec_uid: secUid,
        nickname: nickname || '未命名',
        trigger_times: timesStr.split('\n').map(s => s.trim()).filter(Boolean),
        intent_keywords: intentStr ? intentStr.split('\n').map(s => s.trim()).filter(Boolean) : [],
        garbage_keywords: garbageStr ? garbageStr.split('\n').map(s => s.trim()).filter(Boolean) : [],
        comment_hours: commentHours,
        date_value: days,
        status: 1
      };

      await window.electronAPI.addBlogger(blogger);
      closeModal();
      loadBloggerList();
    });

    return modal;
  }

  async function closeModal() {
    const modal = document.getElementById('blogger-modal');
    if (modal) modal.style.display = 'none';
    await window.electronAPI.showDouyinView();
  }

  async function delBlogger() {
    if (selectedBloggerIdx < 0) { alert('请先选择一个博主'); return; }
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMonitor);
  } else {
    initMonitor();
  }
})();
