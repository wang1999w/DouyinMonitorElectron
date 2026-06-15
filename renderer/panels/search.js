/**
 * 搜索控制面板
 * 排序开关、任务进度、视频标签切换
 */

(function () {
  let searchRunning = false;

  function initSearch() {
    document.getElementById('btn-search-start').addEventListener('click', startSearch);
    document.getElementById('btn-search-pause').addEventListener('click', pauseSearch);
    document.getElementById('btn-search-stop').addEventListener('click', stopSearch);
    document.getElementById('btn-search-schedule').addEventListener('click', saveSchedule);

    // 排序开关：启用/禁用排序选项
    document.getElementById('search-sort-enable').addEventListener('change', (e) => {
      document.getElementById('search-sort-options').style.opacity = e.target.checked ? '1' : '0.4';
      document.querySelectorAll('input[name="search-sort"]').forEach(r => r.disabled = !e.target.checked);
    });

    window.electronAPI.onSearchLog((msg) => updateSearchStatus(msg));
    window.electronAPI.onSearchResult((result) => addSearchResult(result));

    restoreSchedule();
  }

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

    // 排序：读取开关状态
    const sortEnabled = document.getElementById('search-sort-enable').checked;
    let sortMode = 'default';
    if (sortEnabled) {
      sortMode = document.querySelector('input[name="search-sort"]:checked')?.value || 'likes';
    }

    const params = {
      keywords,
      days: parseInt(document.getElementById('search-days').value) || 7,
      filterDate: true,
      maxVideos: parseInt(document.getElementById('search-maxv').value) || 10,
      commentHours: chUnit === '3600' ? chVal * 60 : chVal,
      maxComments: parseInt(document.getElementById('search-maxc').value) || 200,
      sortMode: sortMode,
      sortEnabled: sortEnabled
    };

    // 显示进度面板
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

    // 解析进度信息
    if (msg.includes('搜索关键词:')) {
      const kw = msg.split('搜索关键词:')[1]?.trim() || '';
      document.getElementById('sp-keyword').textContent = `关键词: ${kw}`;
    }
    if (msg.includes('发现') && msg.includes('个视频')) {
      const num = msg.match(/发现 (\d+) 个视频/);
      if (num) document.getElementById('sp-video').textContent = `视频: 0/${num[1]}`;
    }
    if (msg.includes('处理视频')) {
      const m = msg.match(/\[(\d+)\/(\d+)\]/);
      if (m) {
        document.getElementById('sp-video').textContent = `视频: ${m[1]}/${m[2]}`;
        const pct = Math.round((parseInt(m[1]) / parseInt(m[2])) * 100);
        document.getElementById('sp-bar').style.width = pct + '%';
      }
    }
    if (msg.includes('命中')) {
      const m = msg.match(/命中: (\d+)/);
      if (m) document.getElementById('sp-match').textContent = `命中: ${m[1]}`;
    }
    if (msg.includes('CDP:') && msg.includes('条')) {
      const m = msg.match(/CDP: (\d+)条/);
      if (m) document.getElementById('sp-comment').textContent = `评论: ${m[1]}`;
    }

    if (msg.includes('完成') || msg.includes('停止') || msg.includes('失败')) {
      setSearchRunning(false);
      document.getElementById('btn-search-pause').textContent = '暂停';
      document.getElementById('sp-status').textContent = msg.includes('完成') ? '已完成' : '已停止';
      document.getElementById('sp-bar').style.width = '100%';
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

  // ========== 定时任务 ==========

  async function saveSchedule() {
    const cfg = await window.electronAPI.getConfig();
    cfg.search_schedule = {
      enable: document.getElementById('search-schedule-enable').checked,
      interval: parseInt(document.getElementById('search-schedule-interval').value) || 30,
      unit: parseInt(document.getElementById('search-schedule-unit').value) || 60,
      hours: document.getElementById('search-schedule-hours').value.trim()
    };
    await window.electronAPI.saveConfig(cfg);
    alert('定时设置已保存');
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSearch);
  } else {
    initSearch();
  }
})();
