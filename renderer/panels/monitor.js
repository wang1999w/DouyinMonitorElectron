/**
 * 博主监控面板
 * 负责：博主列表管理、监控启停控制、监控结果显示
 */

(function () {
  let selectedBloggerIdx = -1;

  /**
   * 初始化监控面板事件
   */
  function initMonitor() {
    document.getElementById('btn-monitor-add').addEventListener('click', addBlogger);
    document.getElementById('btn-monitor-del').addEventListener('click', delBlogger);
    document.getElementById('btn-monitor-start').addEventListener('click', startMonitor);
    document.getElementById('btn-monitor-stop').addEventListener('click', stopMonitor);
    document.getElementById('btn-save-monitor-kw').addEventListener('click', saveMonitorKeywords);

    // 监听监控日志和结果
    window.electronAPI.onMonitorLog((msg) => {
      updateMonitorStatus(msg);
    });

    window.electronAPI.onMonitorResult((result) => {
      addMonitorResult(result);
    });

    loadBloggerList();
  }

  /**
   * 加载博主列表
   */
  async function loadBloggerList() {
    try {
      const cfg = await window.electronAPI.getConfig();
      const bloggers = cfg.monitor_bloggers || [];
      renderBloggerList(bloggers);
    } catch (e) {}
  }

  /**
   * 渲染博主列表
   * @param {Array} bloggers - 博主配置数组
   */
  function renderBloggerList(bloggers) {
    const container = document.getElementById('blogger-list');
    container.innerHTML = '';

    bloggers.forEach((b, i) => {
      const item = document.createElement('div');
      item.className = 'blogger-item' + (i === selectedBloggerIdx ? ' selected' : '');
      item.innerHTML = `
        <span>${escapeHtml(b.nickname || '未命名')} (${escapeHtml((b.sec_uid || '').substring(0, 10))}...)</span>
        <span>${b.status === 1 ? '启用' : '暂停'}</span>
      `;
      item.addEventListener('click', () => {
        selectedBloggerIdx = i;
        renderBloggerList(bloggers);
      });
      container.appendChild(item);
    });
  }

  /**
   * 弹窗添加博主
   */
  async function addBlogger() {
    const nickname = prompt('博主昵称：');
    if (nickname === null) return;

    const sec_uid = prompt('博主 sec_uid（从主页链接 user/ 后复制）：');
    if (!sec_uid) {
      alert('请填写 sec_uid');
      return;
    }

    const timeRangesStr = prompt('监控时段（每行一个，如 09:00-09:40）：');
    if (!timeRangesStr) {
      alert('请至少填写一个监控时段');
      return;
    }

    const timeRanges = timeRangesStr.split('\n').map(s => s.trim()).filter(Boolean);

    const blogger = {
      sec_uid,
      nickname: nickname || '未命名',
      time_ranges: timeRanges,
      date_mode: 'recent_days',
      date_value: 7,
      status: 1
    };

    await window.electronAPI.addBlogger(blogger);
    loadBloggerList();
  }

  /**
   * 删除选中的博主
   */
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

  /**
   * 启动监控
   */
  async function startMonitor() {
    const cfg = await window.electronAPI.getConfig();
    if (!cfg.monitor_bloggers || cfg.monitor_bloggers.length === 0) {
      alert('请先添加监控博主');
      return;
    }

    setMonitorRunning(true);
    await window.electronAPI.startMonitor();
  }

  /**
   * 停止监控
   */
  async function stopMonitor() {
    await window.electronAPI.stopMonitor();
    setMonitorRunning(false);
  }

  /**
   * 保存监控关键词
   */
  async function saveMonitorKeywords() {
    const cfg = await window.electronAPI.getConfig();
    cfg.monitor_intent_keywords = getTextarea('monitor-intent-kw');
    cfg.monitor_garbage_keywords = getTextarea('monitor-garbage-kw');
    await window.electronAPI.saveConfig(cfg);
    alert('监控关键词已保存');
  }

  /**
   * 更新监控运行状态
   * @param {boolean} running - 是否运行中
   */
  function setMonitorRunning(running) {
    document.getElementById('btn-monitor-start').disabled = running;
    document.getElementById('btn-monitor-stop').disabled = !running;
  }

  /**
   * 更新监控状态文本
   * @param {string} msg - 状态消息
   */
  function updateMonitorStatus(msg) {
    if (msg.includes('已停止')) {
      setMonitorRunning(false);
    }
  }

  /**
   * 添加监控结果到列表
   * @param {Object} result - 意向评论数据
   */
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
      <div class="ri-meta">
        关键词: ${escapeHtml(result.matched_keywords || '')} |
        博主: ${escapeHtml(result.video_author || '')}
      </div>
    `;

    container.insertBefore(item, container.firstChild);

    while (container.children.length > 200) {
      container.removeChild(container.lastChild);
    }
  }

  /**
   * HTML 转义防 XSS
   */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * 从 textarea 获取关键词数组
   */
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
