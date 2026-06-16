/**
 * 小红书搜索面板
 */

(function () {
  let searchRunning = false;

  function initSearch() {
    document.getElementById('xhs-btn-search-start').addEventListener('click', startSearch);
    document.getElementById('xhs-btn-search-stop').addEventListener('click', stopSearch);

    window.xhsAPI.onXhsSearchLog && window.xhsAPI.onXhsSearchLog((msg) => {
      updateStatus(msg);
      appendTaskLog(msg);
    });
    window.xhsAPI.onXhsSearchResult && window.xhsAPI.onXhsSearchResult((result) => addResult(result));
    window.xhsAPI.onXhsSearchProgress && window.xhsAPI.onXhsSearchProgress((p) => applyProgress(p));
  }

  async function startSearch() {
    const rawKw = document.getElementById('xhs-search-keywords').value.trim();
    if (!rawKw) { window.Toast && window.Toast.warn('请输入搜索关键词'); return; }
    const keywords = rawKw.split('\n').map(s => s.trim()).filter(Boolean);
    if (keywords.length === 0) return;

    const chVal = parseInt(document.getElementById('xhs-search-ch')?.value) || 60;
    const chUnit = parseInt(document.getElementById('xhs-search-ch-unit')?.value) || 1;
    const commentHours = chVal * chUnit;

    const params = {
      keywords,
      maxNotes: parseInt(document.getElementById('xhs-search-maxn').value) || 10,
      maxComments: parseInt(document.getElementById('xhs-search-maxc').value) || 200,
      commentHours
    };

    setSearchRunning(true);
    showProgress(true, keywords[0]);
    await window.xhsAPI.xhsStartSearch(params);
  }

  async function stopSearch() {
    await window.xhsAPI.xhsStopSearch();
    setSearchRunning(false);
    showProgress(false);
  }

  function setSearchRunning(running) {
    searchRunning = running;
    document.getElementById('xhs-btn-search-start').disabled = running;
    document.getElementById('xhs-btn-search-stop').disabled = !running;
  }

  function updateStatus(msg) {
    const el = document.getElementById('xhs-search-status');
    if (el) el.textContent = msg;
    if (msg.includes('完成') || msg.includes('停止')) {
      setSearchRunning(false);
    }
  }

  function applyProgress(p) {
    if (!p) return;
    const el = document.getElementById('xhs-search-progress');
    if (el) el.style.display = 'block';
    if (typeof p.videoIndex === 'number') {
      document.getElementById('xhs-sp-note').textContent = `笔记: ${p.videoIndex}/${p.videoTotal || p.videoIndex}`;
    }
    if (typeof p.matchedTotal === 'number') {
      document.getElementById('xhs-sp-match').textContent = `命中: ${p.matchedTotal}`;
    }
  }

  function showProgress(show, kw) {
    const el = document.getElementById('xhs-search-progress');
    el.style.display = show ? 'block' : 'none';
    if (show) {
      document.getElementById('xhs-sp-keyword').textContent = `关键词: ${kw || '-'}`;
      document.getElementById('xhs-sp-note').textContent = '笔记: 0/0';
      document.getElementById('xhs-sp-match').textContent = '命中: 0';
    }
  }

  function addResult(result) {
    const container = document.getElementById('xhs-search-results');
    const item = document.createElement('div');
    item.className = 'result-item';
    const score = result.score || 0;
    const scoreClass = score >= 10 ? 'score-high' : score >= 5 ? 'score-mid' : 'score-low';
    item.innerHTML = `
      <div class="ri-header">
        <span class="ri-nick">${escapeHtml(result.nickname || '')}</span>
        <span class="ri-score ${scoreClass}">${score}分</span>
      </div>
      <div class="ri-comment">${escapeHtml(result.comment_text || result.text || '')}</div>
      <div class="ri-meta">关键词: ${escapeHtml(Array.isArray(result.matched_keywords) ? result.matched_keywords.join(',') : (result.matched_keywords || ''))} | 博主: ${escapeHtml(result.note_author || result.video_author || '')}</div>
    `;
    container.insertBefore(item, container.firstChild);
    while (container.children.length > 200) container.removeChild(container.lastChild);
  }

  function appendTaskLog(msg) {
    const el = document.getElementById('xhs-search-task-log');
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
    document.addEventListener('DOMContentLoaded', initSearch);
  } else {
    initSearch();
  }
})();
