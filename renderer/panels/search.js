/**
 * 搜索控制面板
 * 负责：搜索参数收集、搜索启停控制、搜索结果显示、定时任务管理
 */

(function () {
  let searchRunning = false;
  let scheduleTimer = null;
  let scheduleRunning = false;

  function initSearch() {
    document.getElementById('btn-search-start').addEventListener('click', startSearch);
    document.getElementById('btn-search-pause').addEventListener('click', pauseSearch);
    document.getElementById('btn-search-stop').addEventListener('click', stopSearch);
    document.getElementById('btn-search-schedule').addEventListener('click', saveSchedule);

    window.electronAPI.onSearchLog((msg) => updateSearchStatus(msg));
    window.electronAPI.onSearchResult((result) => addSearchResult(result));

    // 启动时恢复定时任务状态
    restoreSchedule();
  }

  /**
   * 收集搜索参数并启动搜索
   */
  async function startSearch() {
    const rawKw = document.getElementById('search-keywords').value.trim();
    if (!rawKw) { alert('请输入搜索关键词'); return; }

    let keywords = rawKw.split('\n').map(s => s.trim()).filter(Boolean);
    if (document.getElementById('search-add-hash').checked) {
      keywords = keywords.map(k => k.startsWith('#') ? k : '#' + k);
    }
    if (keywords.length === 0) { alert('请输入有效关键词'); return; }

    const chVal = parseInt(document.getElementById('search-ch').value) || 60;
    const chUnit = document.getElementById('search-ch-unit').value;

    const params = {
      keywords,
      multiKw: document.getElementById('search-multi-kw').checked,
      days: parseInt(document.getElementById('search-days').value) || 7,
      filterDate: true,
      maxVideos: parseInt(document.getElementById('search-maxv').value) || 10,
      commentHours: chUnit === '3600' ? chVal * 60 : chVal,
      maxComments: parseInt(document.getElementById('search-maxc').value) || 200,
      sortMode: document.querySelector('input[name="search-sort"]:checked')?.value || 'likes'
    };

    setSearchRunning(true);
    await window.electronAPI.startSearch(params);
  }

  async function pauseSearch() {
    await window.electronAPI.pauseSearch();
    const btn = document.getElementById('btn-search-pause');
    btn.textContent = btn.textContent === '暂停' ? '继续' : '暂停';
  }

  async function stopSearch() {
    await window.electronAPI.stopSearch();
    setSearchRunning(false);
    document.getElementById('btn-search-pause').textContent = '暂停';
  }

  function setSearchRunning(running) {
    searchRunning = running;
    document.getElementById('btn-search-start').disabled = running;
    document.getElementById('btn-search-pause').disabled = !running;
    document.getElementById('btn-search-stop').disabled = !running;
  }

  function updateSearchStatus(msg) {
    const el = document.getElementById('search-status');
    if (el) el.textContent = msg;
    if (msg.includes('完成') || msg.includes('停止') || msg.includes('失败')) {
      setSearchRunning(false);
      document.getElementById('btn-search-pause').textContent = '暂停';
    }
  }

  function addSearchResult(result) {
    const container = document.getElementById('search-results');
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
      <div class="ri-comment">${escapeHtml(result.comment_text || '')}</div>
      <div class="ri-meta">关键词: ${escapeHtml(keywords)} | 博主: ${escapeHtml(result.video_author || '')} | ${result.comment_time || ''}</div>
    `;
    container.insertBefore(item, container.firstChild);
    while (container.children.length > 200) container.removeChild(container.lastChild);
  }

  // ========== 定时任务 ==========

  /**
   * 保存定时搜索设置
   */
  async function saveSchedule() {
    const cfg = await window.electronAPI.getConfig();
    cfg.search_schedule = {
      enable: document.getElementById('search-schedule-enable').checked,
      interval: parseInt(document.getElementById('search-schedule-interval').value) || 30,
      unit: parseInt(document.getElementById('search-schedule-unit').value) || 60,
      hours: document.getElementById('search-schedule-hours').value.trim()
    };
    await window.electronAPI.saveConfig(cfg);
    applySchedule(cfg.search_schedule);
    alert('定时设置已保存');
  }

  /**
   * 应用定时任务
   * @param {Object} schedule - 定时配置
   */
  function applySchedule(schedule) {
    if (scheduleTimer) {
      clearInterval(scheduleTimer);
      scheduleTimer = null;
      scheduleRunning = false;
    }

    if (!schedule || !schedule.enable) {
      updateScheduleStatus('定时任务已关闭');
      return;
    }

    const intervalMs = (schedule.interval || 30) * (schedule.unit || 60) * 1000;
    scheduleRunning = true;

    scheduleTimer = setInterval(async () => {
      if (searchRunning) return; // 上一次还没完成就跳过
      if (!isInScheduleHours(schedule.hours)) return;

      updateScheduleStatus(`定时触发 - ${new Date().toLocaleTimeString()}`);
      await startSearch();
    }, intervalMs);

    updateScheduleStatus(`已启用 - 每${schedule.interval}${schedule.unit === 3600 ? '小时' : '分钟'}执行`);
  }

  /**
   * 检查当前时间是否在执行时段内
   * @param {string} hoursStr - 时段字符串 "08:00-22:00"
   * @returns {boolean}
   */
  function isInScheduleHours(hoursStr) {
    if (!hoursStr) return true;
    try {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const parts = hoursStr.split('-');
      const [sh, sm] = parts[0].split(':').map(Number);
      const [eh, em] = parts[1].split(':').map(Number);
      return nowMin >= sh * 60 + sm && nowMin <= eh * 60 + em;
    } catch (e) {
      return true;
    }
  }

  /**
   * 恢复定时任务状态（应用启动时）
   */
  async function restoreSchedule() {
    try {
      const cfg = await window.electronAPI.getConfig();
      const schedule = cfg.search_schedule;
      if (schedule) {
        document.getElementById('search-schedule-enable').checked = schedule.enable || false;
        document.getElementById('search-schedule-interval').value = schedule.interval || 30;
        document.getElementById('search-schedule-unit').value = schedule.unit || 60;
        document.getElementById('search-schedule-hours').value = schedule.hours || '';
        if (schedule.enable) applySchedule(schedule);
      }
    } catch (e) {}
  }

  function updateScheduleStatus(msg) {
    const el = document.getElementById('search-schedule-status');
    if (el) el.textContent = msg;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSearch);
  } else {
    initSearch();
  }
})();
