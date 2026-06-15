/**
 * 搜索控制面板
 * 数量模式/时间模式切换、排序开关、任务进度
 */

(function () {
  let searchRunning = false;
  let currentMode = 'quantity'; // 'quantity' 或 'time'

  // 全局模式切换函数（供 HTML onclick 调用）
  window.switchMode = function(mode) {
    currentMode = mode;
    document.getElementById('mode-quantity').classList.toggle('active', mode === 'quantity');
    document.getElementById('mode-time').classList.toggle('active', mode === 'time');
    document.getElementById('mode-quantity-panel').style.display = mode === 'quantity' ? '' : 'none';
    document.getElementById('mode-time-panel').style.display = mode === 'time' ? '' : 'none';
  };

  function initSearch() {
    document.getElementById('btn-search-start').addEventListener('click', startSearch);
    document.getElementById('btn-search-pause').addEventListener('click', pauseSearch);
    document.getElementById('btn-search-stop').addEventListener('click', stopSearch);
    document.getElementById('btn-search-schedule').addEventListener('click', saveSchedule);

    // 筛选选项点击切换 active 状态
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        const group = chip.dataset.group;
        chip.closest('.filter-options').querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        chip.querySelector('input').checked = true;
      });
    });

    window.electronAPI.onSearchLog((msg) => {
      updateSearchStatus(msg);
      appendTaskLog('search', msg);
    });
    window.electronAPI.onSearchResult((result) => addSearchResult(result));
    // 事件驱动进度（不再依赖日志正则）
    document.addEventListener('search-progress', (e) => applyProgress(e.detail));
    restoreSchedule();
  }

  async function startSearch() {
    const rawKw = document.getElementById('search-keywords').value.trim();
    if (!rawKw) { window.Toast && window.Toast.warn('请输入搜索关键词'); return; }

    let keywords = rawKw.split('\n').map(s => s.trim()).filter(Boolean);
    if (document.getElementById('search-add-hash').checked) {
      keywords = keywords.map(k => k.startsWith('#') ? k : '#' + k);
    }
    if (keywords.length === 0) { window.Toast && window.Toast.warn('请输入有效关键词'); return; }

    let params = { keywords, sortEnabled: false, sortMode: 'default' };

    if (currentMode === 'quantity') {
      // 数量模式：读取所有筛选参数
      const chVal = parseInt(document.getElementById('search-ch')?.value) || 60;
      const chUnit = parseInt(document.getElementById('search-ch-unit')?.value) || 1;
      const commentHours = chVal * chUnit; // 分钟或小时转换为分钟
      params = {
        ...params,
        days: parseInt(document.querySelector('input[name="search-time"]:checked')?.value) || 0,
        filterDate: document.querySelector('input[name="search-time"]:checked')?.value !== '0',
        maxVideos: parseInt(document.getElementById('search-maxv').value) || 10,
        commentHours: commentHours,
        maxComments: parseInt(document.getElementById('search-maxc').value) || 200,
        sortEnabled: true,
        sortMode: document.querySelector('input[name="search-sort"]:checked')?.value || 'default',
        filterTime: document.querySelector('input[name="search-time"]:checked')?.value || '0',
        filterDuration: document.querySelector('input[name="search-duration-filter"]:checked')?.value || '0',
        filterScope: document.querySelector('input[name="search-scope"]:checked')?.value || '0',
        filterContentType: document.querySelector('input[name="search-content-type"]:checked')?.value || '0'
      };
    } else {
      // 时间模式
      const duration = parseInt(document.getElementById('search-duration').value) || 30;
      const durationUnit = parseInt(document.getElementById('search-duration-unit').value) || 60;
      const chVal = parseInt(document.getElementById('search-ch-time').value) || 60;
      const chUnit = parseInt(document.getElementById('search-ch-unit-time').value) || 60;
      params = {
        ...params,
        days: 7,
        filterDate: false,
        maxVideos: 9999,
        commentHours: chUnit === 3600 ? chVal * 60 : chVal,
        maxComments: 999,
        taskDuration: duration * durationUnit * 1000,
        sortEnabled: false,
        sortMode: 'default'
      };
    }

    showProgress(true, keywords[0], 0, keywords.length, 0, 0);
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
    showProgress(false);
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

    // 兜底：日志里仅保留最弱状态变化（不再解析进度数字）
    if (msg.includes('搜索关键词:')) {
      const kw = msg.split('搜索关键词:')[1]?.trim() || '';
      document.getElementById('sp-keyword').textContent = `关键词: ${kw}`;
    }
    if (msg.includes('完成') || msg.includes('停止') || msg.includes('失败')) {
      setSearchRunning(false);
      document.getElementById('btn-search-pause').textContent = '暂停';
      document.getElementById('sp-status').textContent = msg.includes('完成') ? '已完成' : '已停止';
      document.getElementById('sp-bar').style.width = '100%';
    }
  }

  /**
   * 应用事件驱动的进度
   * @param {Object} p - { phase, awemeId, cdpCount, domCount, matchCount, videoIndex, videoTotal, matchedTotal, cdpTotal, domTotal }
   */
  function applyProgress(p) {
    if (!p) return;
    const el = document.getElementById('search-progress');
    if (el) el.style.display = 'block';
    if (typeof p.videoIndex === 'number') {
      document.getElementById('sp-video').textContent = `视频: ${p.videoIndex}/${p.videoTotal || p.videoIndex}`;
      const total = p.videoTotal && p.videoTotal > 0 ? p.videoTotal : 1;
      const pct = Math.min(100, Math.round((p.videoIndex / total) * 100));
      document.getElementById('sp-bar').style.width = pct + '%';
    }
    if (typeof p.cdpTotal === 'number' || typeof p.domTotal === 'number') {
      const cdp = p.cdpTotal || 0;
      const dom = p.domTotal || 0;
      document.getElementById('sp-comment').textContent = `评论: ${cdp + dom}`;
    }
    if (typeof p.matchedTotal === 'number') {
      document.getElementById('sp-match').textContent = `命中: ${p.matchedTotal}`;
    }
  }

  function showProgress(show, kw, videoIdx, videoTotal, comments, matchCount) {
    const el = document.getElementById('search-progress');
    el.style.display = show ? 'block' : 'none';
    if (show) {
      document.getElementById('sp-keyword').textContent = `关键词: ${kw || '-'}`;
      document.getElementById('sp-video').textContent = `视频: ${videoIdx || 0}/${videoTotal || 0}`;
      document.getElementById('sp-comment').textContent = `评论: ${comments || 0}`;
      document.getElementById('sp-match').textContent = `命中: ${matchCount || 0}`;
      document.getElementById('sp-status').textContent = '运行中';
      document.getElementById('sp-bar').style.width = '0%';
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

  async function saveSchedule() {
    const cfg = await window.electronAPI.getConfig();
    const enabled = document.getElementById('search-schedule-enable').checked;
    const intervalVal = parseInt(document.getElementById('search-schedule-interval').value) || 30;
    const unitVal = parseInt(document.getElementById('search-schedule-unit').value) || 60;
    const hoursStr = document.getElementById('search-schedule-hours').value.trim() || '08:00-22:00';
    const m = hoursStr.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    const startHour = m ? Number(m[1]) : 8;
    const endHour = m ? Number(m[3]) : 22;
    // intervalMinutes = 字段单位换算:unit=60 是分钟，unit=3600 是小时
    const intervalMinutes = unitVal === 3600 ? intervalVal * 60 : intervalVal;
    cfg.search_schedule = {
      enabled,
      startHour,
      endHour,
      intervalMinutes,
      // 兼容 UI 回显字段
      enable: enabled,
      interval: intervalVal,
      unit: unitVal,
      hours: hoursStr
    };
    await window.electronAPI.saveConfig(cfg);
    window.Toast && window.Toast.success('定时设置已保存');
  }

  async function restoreSchedule() {
    try {
      const cfg = await window.electronAPI.getConfig();
      const s = cfg.search_schedule;
      if (s) {
        document.getElementById('search-schedule-enable').checked = s.enable || false;
        document.getElementById('search-schedule-interval').value = s.interval || 30;
        document.getElementById('search-schedule-unit').value = s.unit || 60;
        document.getElementById('search-schedule-hours').value = s.hours || '';
      }
    } catch (e) {}
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** 写入搜索任务独立日志 */
  function appendTaskLog(type, msg) {
    const logId = type === 'search' ? 'search-task-log' : 'monitor-task-log';
    const countId = type === 'search' ? 'search-log-count' : 'monitor-log-count';
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
    // 更新计数
    const countEl = document.getElementById(countId);
    if (countEl) countEl.textContent = el.children.length + '条';
    // 限制条数
    while (el.children.length > 300) el.removeChild(el.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSearch);
  } else {
    initSearch();
  }
})();
