/**
 * 博主监控面板
 * 重构：每个博主独立意向/垃圾关键词
 * 时段设置：设定时间节点，到时间自动执行
 * 优先级：监控触发时暂停搜索，完成后恢复
 */

(function () {
  let selectedBloggerIdx = -1;
  let currentBloggers = [];
  let editMode = false; // false=添加, true=编辑

  function initMonitor() {
    document.getElementById('btn-monitor-add').addEventListener('click', () => showAddBloggerModal(false));
    document.getElementById('btn-monitor-edit').addEventListener('click', () => showAddBloggerModal(true));
    document.getElementById('btn-monitor-del').addEventListener('click', delBlogger);
    document.getElementById('btn-monitor-start').addEventListener('click', startMonitor);
    document.getElementById('btn-monitor-stop').addEventListener('click', stopMonitor);
    const pauseBtn = document.getElementById('btn-monitor-pause');
    if (pauseBtn) pauseBtn.addEventListener('click', pauseMonitor);

    window.electronAPI.onMonitorLog((msg) => {
      updateMonitorStatus(msg);
      appendTaskLog('monitor', msg);
    });
    window.electronAPI.onMonitorResult((result) => addMonitorResult(result));
    // ★ 监听任务完成事件（权威状态更新）— 无论正常/异常/停止都会触发
    if (window.electronAPI.onMonitorCompleted) {
      window.electronAPI.onMonitorCompleted((info) => {
        setMonitorRunning(false);
        appendTaskLog('monitor', (info && info.success === false && info.reason === 'error')
          ? `❌ 监控任务失败: ${info.message || '未知错误'}`
          : (info && info.reason === 'user_stopped' ? '🛑 监控任务已停止' : '✅ 监控任务已完成'));
      });
    }
    // 事件驱动进度
    document.addEventListener('monitor-progress', (e) => applyMonitorProgress(e.detail));

    loadBloggerList();
  }

  function applyMonitorProgress(p) {
    if (!p) return;
    // 监控没有进度条，落到状态栏
    if (typeof p.matchedTotal === 'number') {
      const el = document.getElementById('search-status');
      if (el) el.textContent = `监控已命中 ${p.matchedTotal} 条`;
    }
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
   * 显示添加博主模态框（同时支持编辑）
   * @param {boolean} edit - true=编辑当前选中, false=添加新博主
   */
  async function showAddBloggerModal(edit = false) {
    if (edit && selectedBloggerIdx < 0) {
      window.Toast && window.Toast.warn('请先选中要编辑的博主');
      return;
    }
    editMode = edit;
    await window.electronAPI.hideDouyinView();
    let modal = document.getElementById('blogger-modal');
    if (!modal) { modal = createBloggerModal(); document.body.appendChild(modal); }

    const titleEl = modal.querySelector('h3');
    if (titleEl) titleEl.textContent = edit ? '编辑博主' : '添加监控博主';

    if (edit) {
      const b = currentBloggers[selectedBloggerIdx];
      document.getElementById('bm-nickname').value = b.nickname || '';
      document.getElementById('bm-secuid').value = b.sec_uid || '';
      document.getElementById('bm-secuid').disabled = true; // 编辑时不允许改 sec_uid
      document.getElementById('bm-times').value = (b.trigger_times || []).join('\n');
      document.getElementById('bm-intent-kw').value = (b.intent_keywords || []).join('\n');
      document.getElementById('bm-garbage-kw').value = (b.garbage_keywords || []).join('\n');
      const hours = b.comment_hours || 60;
      document.getElementById('bm-comment-hours').value = hours >= 60 && hours % 60 === 0 ? hours / 60 : hours;
      document.getElementById('bm-comment-unit').value = hours >= 60 && hours % 60 === 0 ? 60 : 1;
      document.getElementById('bm-days').value = String(b.date_value || 7);
      document.getElementById('bm-status').checked = b.status !== 0;
    } else {
      document.getElementById('bm-nickname').value = '';
      document.getElementById('bm-secuid').value = '';
      document.getElementById('bm-secuid').disabled = false;
      document.getElementById('bm-times').value = '09:00\n14:00';
      document.getElementById('bm-intent-kw').value = '';
      document.getElementById('bm-garbage-kw').value = '';
      document.getElementById('bm-comment-hours').value = 60;
      document.getElementById('bm-comment-unit').value = 1;
      document.getElementById('bm-days').value = '7';
      document.getElementById('bm-status').checked = true;
    }
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
            <label style="display:block;font-size:12px;color:#666;margin-bottom:3px;">博主主页地址 <span style="color:#999;">（支持 sec_uid / 完整主页URL / 短链分享URL）</span></label>
            <input type="text" id="bm-secuid" placeholder="MS4wLjABAAAA... 或 https://www.douyin.com/user/... 或 https://v.douyin.com/..." style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;">
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

        <div style="margin-bottom:10px;">
          <label style="font-size:12px;color:#666;"><input type="checkbox" id="bm-status" checked> 启用监控（取消勾选 = 暂停）</label>
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
      const status = document.getElementById('bm-status').checked ? 1 : 0;

      if (!secUid) { window.Toast && window.Toast.warn('请填写博主主页地址或 sec_uid'); return; }
      // ★ 校验：sec_uid 字段允许三种格式
      //   1. 纯 sec_uid（长度>30，无斜杠/冒号）
      //   2. 完整主页URL（含 douyin.com/user/）
      //   3. 短链分享URL（含 v.douyin.com 或其他 douyin 域名）
      if (!isValidBloggerIdentifier(secUid)) {
        window.Toast && window.Toast.warn('博主地址格式不正确\n支持：纯 sec_uid / 完整主页URL / 短链分享URL');
        return;
      }
      if (!timesStr) { window.Toast && window.Toast.warn('请至少填写一个触发时间点'); return; }
      // ★ 校验：触发时间格式（HH:MM）
      const times = timesStr.split('\n').map(s => s.trim()).filter(Boolean);
      for (const t of times) {
        if (!/^\d{1,2}:\d{2}$/.test(t)) {
          window.Toast && window.Toast.warn(`触发时间格式错误: "${t}"\n请使用 HH:MM 格式，如 09:00`);
          return;
        }
      }
      // ★ 校验：评论时效范围（1-1440小时）
      if (commentHours < 1 || commentHours > 1440) {
        window.Toast && window.Toast.warn('评论时效范围: 1-1440小时');
        return;
      }

      let result;
      if (editMode) {
        const updates = {
          nickname: nickname || '未命名',
          trigger_times: times,
          intent_keywords: intentStr ? intentStr.split('\n').map(s => s.trim()).filter(Boolean) : [],
          garbage_keywords: garbageStr ? garbageStr.split('\n').map(s => s.trim()).filter(Boolean) : [],
          comment_hours: commentHours,
          date_value: days,
          status
        };
        result = await window.electronAPI.updateBlogger({ secUid, updates });
      } else {
        const blogger = {
          sec_uid: secUid,
          nickname: nickname || '未命名',
          trigger_times: times,
          intent_keywords: intentStr ? intentStr.split('\n').map(s => s.trim()).filter(Boolean) : [],
          garbage_keywords: garbageStr ? garbageStr.split('\n').map(s => s.trim()).filter(Boolean) : [],
          comment_hours: commentHours,
          date_value: days,
          status
        };
        result = await window.electronAPI.addBlogger(blogger);
      }

      if (result && result.success) {
        window.Toast && window.Toast.success(editMode ? '博主已更新' : '博主已添加');
      } else {
        window.Toast && window.Toast.error((result && result.error) || '保存失败');
      }
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
    if (selectedBloggerIdx < 0) { window.Toast && window.Toast.warn('请先选择一个博主'); return; }
    const target = currentBloggers[selectedBloggerIdx];
    const name = target ? (target.nickname || '未命名') : '该博主';
    const ok = await showConfirmModal(`确定删除博主「${name}」吗？此操作不可恢复。`);
    if (!ok) return;
    await window.electronAPI.delBlogger(target ? target.sec_uid : selectedBloggerIdx);
    selectedBloggerIdx = -1;
    loadBloggerList();
  }

  /**
   * 自定义确认对话框（避免 confirm() 阻塞 UI）
   * @param {string} message
   * @returns {Promise<boolean>}
   */
  function showConfirmModal(message) {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;justify-content:center;align-items:center;';
      modal.innerHTML = `
        <div style="background:#fff;border-radius:8px;padding:20px 24px;min-width:300px;max-width:480px;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
          <div style="font-size:14px;color:#333;margin-bottom:16px;line-height:1.6;">${escapeHtml(message)}</div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button data-act="cancel" style="padding:6px 14px;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer;font-size:12px;">取消</button>
            <button data-act="ok" style="padding:6px 14px;border:none;background:#d93025;color:#fff;border-radius:4px;cursor:pointer;font-size:12px;">确定</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      const cleanup = (val) => {
        modal.remove();
        resolve(val);
      };
      modal.addEventListener('click', (e) => {
        if (e.target === modal) cleanup(false);
      });
      modal.querySelector('[data-act="cancel"]').addEventListener('click', () => cleanup(false));
      modal.querySelector('[data-act="ok"]').addEventListener('click', () => cleanup(true));
    });
  }

  async function startMonitor() {
    const cfg = await window.electronAPI.getConfig();
    if (!cfg.monitor_bloggers || cfg.monitor_bloggers.length === 0) {
      window.Toast && window.Toast.warn('请先添加监控博主');
      return;
    }
    // ★ 校验：至少有一个启用的博主
    const enabledBloggers = cfg.monitor_bloggers.filter(b => b.status === 1);
    if (enabledBloggers.length === 0) {
      window.Toast && window.Toast.warn('没有启用的博主，请先在编辑中启用');
      return;
    }
    // ★ 校验：启用的博主至少有一个配置了触发时间
    const withTriggers = enabledBloggers.filter(b => (b.trigger_times || []).length > 0);
    if (withTriggers.length === 0) {
      window.Toast && window.Toast.warn('启用的博主未配置触发时间\n请在编辑中设置触发时间点（如 09:00）');
      return;
    }
    setMonitorRunning(true);
    await window.electronAPI.startMonitor();
    // ★ 提示待命模式
    const allTimes = withTriggers.map(b => (b.trigger_times || []).join(', ')).join(' / ');
    window.Toast && window.Toast.info(`监控已进入待命模式\n将在预设时间自动触发: ${allTimes}`);
  }

  async function stopMonitor() {
    // ★ 超时保护：避免后端卡住导致按钮永远 disabled
    try {
      await Promise.race([
        window.electronAPI.stopMonitor(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3000))
      ]);
    } catch (e) {
      console.error('stopMonitor异常:', e.message);
    }
    setMonitorRunning(false);
  }

  async function pauseMonitor() {
    try {
      await Promise.race([
        window.electronAPI.pauseMonitor(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3000))
      ]);
    } catch (e) {
      console.error('pauseMonitor异常:', e.message);
    }
    // 暂停状态由日志回调 updateMonitorStatus 更新按钮文字
    // 这里只确保按钮可用性正确
    const pauseBtn = document.getElementById('btn-monitor-pause');
    if (pauseBtn) {
      // 切换文字（实际状态以后端 isPaused 为准，这里乐观更新）
      pauseBtn.textContent = pauseBtn.textContent === '暂停' ? '恢复' : '暂停';
    }
  }

  function setMonitorRunning(running) {
    document.getElementById('btn-monitor-start').disabled = running;
    const pauseBtn = document.getElementById('btn-monitor-pause');
    const stopBtn = document.getElementById('btn-monitor-stop');
    if (pauseBtn) {
      pauseBtn.disabled = !running;
      // 启动/停止时重置文字
      if (!running) pauseBtn.textContent = '暂停';
    }
    if (stopBtn) stopBtn.disabled = !running;
  }

  function updateMonitorStatus(msg) {
    // ★ 修复：只对任务级状态消息禁用按钮，避免日志中的"完成"误触发
    if (msg.includes('监控任务已停止') || msg.includes('监控任务失败')) {
      setMonitorRunning(false);
    }
    // 暂停/恢复文字切换
    const pauseBtn = document.getElementById('btn-monitor-pause');
    if (pauseBtn) {
      if (msg.includes('监控已暂停')) pauseBtn.textContent = '恢复';
      else if (msg.includes('监控已恢复')) pauseBtn.textContent = '暂停';
    }
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

  /**
   * 校验博主标识符格式
   * 支持三种格式：
   *   1. 纯 sec_uid（长度>30，无斜杠/冒号）
   *   2. 完整主页URL（含 douyin.com/user/）
   *   3. 短链分享URL（含 v.douyin.com 或其他 douyin 域名，允许带杂质文本）
   */
  function isValidBloggerIdentifier(raw) {
    if (!raw || typeof raw !== 'string') return false;
    const s = raw.trim();
    if (!s) return false;
    // 规则1: 纯 sec_uid
    if (!s.includes('/') && !s.includes(':') && s.length > 30) return true;
    // 规则2: 完整主页URL
    if (/douyin\.com\/user\//.test(s)) return true;
    // 规则3: 短链分享URL（含杂质文本也允许）
    if (/https?:\/\/[^\s]*douyin\.com\/[A-Za-z0-9]+\/?/.test(s)) return true;
    return false;
  }

  /** 写入监控任务独立日志 */
  function appendTaskLog(type, msg) {
    const logId = 'monitor-task-log';
    const countId = 'monitor-log-count';
    const el = document.getElementById(logId);
    if (!el) return;
    const ts = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.style.cssText = 'white-space:pre-wrap;word-break:break-all;padding:1px 0;';
    if (msg.includes('异常') || msg.includes('失败') || msg.includes('错误')) {
      line.style.color = '#f44336';
    } else if (msg.includes('完成') || msg.includes('成功')) {
      line.style.color = '#4caf50';
    } else if (msg.includes('⚠') || msg.includes('验证')) {
      line.style.color = '#ff9800';
    }
    line.textContent = `[${ts}] ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    const countEl = document.getElementById(countId);
    if (countEl) countEl.textContent = el.children.length + '条';
    while (el.children.length > 300) el.removeChild(el.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMonitor);
  } else {
    initMonitor();
  }
})();
