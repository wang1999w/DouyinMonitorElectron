/**
 * 搜索控制面板
 * 负责：搜索参数收集、搜索启停控制、搜索结果显示
 */

(function () {
  let searchRunning = false;

  /**
   * 初始化搜索面板事件
   */
  function initSearch() {
    const startBtn = document.getElementById('btn-search-start');
    const pauseBtn = document.getElementById('btn-search-pause');
    const stopBtn = document.getElementById('btn-search-stop');

    startBtn.addEventListener('click', startSearch);
    pauseBtn.addEventListener('click', pauseSearch);
    stopBtn.addEventListener('click', stopSearch);

    // 监听搜索日志和结果
    window.electronAPI.onSearchLog((msg) => {
      updateSearchStatus(msg);
    });

    window.electronAPI.onSearchResult((result) => {
      addSearchResult(result);
    });
  }

  /**
   * 收集搜索参数并启动搜索
   */
  async function startSearch() {
    const rawKw = document.getElementById('search-keywords').value.trim();
    if (!rawKw) {
      alert('请输入搜索关键词');
      return;
    }

    let keywords = rawKw.split('\n').map(s => s.trim()).filter(Boolean);

    // 自动加 # 前缀
    if (document.getElementById('search-add-hash').checked) {
      keywords = keywords.map(k => k.startsWith('#') ? k : '#' + k);
    }

    if (keywords.length === 0) {
      alert('请输入有效关键词');
      return;
    }

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

  /**
   * 暂停/恢复搜索
   */
  async function pauseSearch() {
    await window.electronAPI.pauseSearch();
    const btn = document.getElementById('btn-search-pause');
    btn.textContent = btn.textContent === '暂停' ? '继续' : '暂停';
  }

  /**
   * 停止搜索
   */
  async function stopSearch() {
    await window.electronAPI.stopSearch();
    setSearchRunning(false);
    document.getElementById('btn-search-pause').textContent = '暂停';
  }

  /**
   * 更新搜索运行状态
   * @param {boolean} running - 是否运行中
   */
  function setSearchRunning(running) {
    searchRunning = running;
    document.getElementById('btn-search-start').disabled = running;
    document.getElementById('btn-search-pause').disabled = !running;
    document.getElementById('btn-search-stop').disabled = !running;
  }

  /**
   * 更新搜索状态文本
   * @param {string} msg - 状态消息
   */
  function updateSearchStatus(msg) {
    const el = document.getElementById('search-status');
    if (el) el.textContent = msg;

    if (msg.includes('完成') || msg.includes('停止') || msg.includes('失败')) {
      setSearchRunning(false);
      document.getElementById('btn-search-pause').textContent = '暂停';
    }
  }

  /**
   * 添加搜索结果到列表
   * @param {Object} result - 意向评论数据
   */
  function addSearchResult(result) {
    const container = document.getElementById('search-results');
    const item = document.createElement('div');
    item.className = 'result-item';

    const score = result.score || 0;
    const scoreClass = score >= 10 ? 'score-high' : score >= 5 ? 'score-mid' : 'score-low';
    const keywords = Array.isArray(result.matched_keywords)
      ? result.matched_keywords.join(',')
      : (result.matched_keywords || '');

    item.innerHTML = `
      <div class="ri-header">
        <span class="ri-nick">${escapeHtml(result.nickname || '')}</span>
        <span class="ri-score ${scoreClass}">${score}分</span>
      </div>
      <div class="ri-comment">${escapeHtml(result.comment_text || '')}</div>
      <div class="ri-meta">
        关键词: ${escapeHtml(keywords)} |
        博主: ${escapeHtml(result.video_author || '')} |
        ${result.comment_time || ''}
      </div>
    `;

    container.insertBefore(item, container.firstChild);

    // 限制结果条数
    while (container.children.length > 200) {
      container.removeChild(container.lastChild);
    }
  }

  /**
   * HTML 转义防 XSS
   * @param {string} str - 原始字符串
   * @returns {string} 转义后的字符串
   */
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
