/**
 * 小红书推荐页浏览面板
 */

(function () {
  let recommendRunning = false;

  function initRecommend() {
    document.getElementById('xhs-btn-recommend-start').addEventListener('click', startRecommend);
    document.getElementById('xhs-btn-recommend-pause').addEventListener('click', pauseRecommend);
    document.getElementById('xhs-btn-recommend-stop').addEventListener('click', stopRecommend);

    // 监听日志
    window.xhsAPI.onXhsRecommendLog && window.xhsAPI.onXhsRecommendLog((msg) => {
      updateRecommendStatus(msg);
      appendTaskLog(msg);
    });

    // 监听结果
    window.xhsAPI.onXhsRecommendResult && window.xhsAPI.onXhsRecommendResult((result) => {
      addRecommendResult(result);
    });

    // 监听进度
    window.xhsAPI.onXhsRecommendProgress && window.xhsAPI.onXhsRecommendProgress((p) => {
      applyProgress(p);
    });

    // 设置结束时间默认值（当前时间+1小时）
    const now = new Date();
    now.setHours(now.getHours() + 1);
    const defaultEnd = now.toISOString().slice(0, 16);
    document.getElementById('xhs-recommend-end-time').value = defaultEnd;
  }

  async function startRecommend() {
    const rawKw = document.getElementById('xhs-recommend-video-kw').value.trim();
    if (!rawKw) { window.Toast && window.Toast.warn('请输入笔记关键词'); return; }

    const videoKeywords = rawKw.split('\n').map(s => s.trim()).filter(Boolean);
    if (videoKeywords.length === 0) { window.Toast && window.Toast.warn('请输入有效关键词'); return; }

    const chVal = parseInt(document.getElementById('xhs-recommend-ch').value) || 60;
    const commentHours = chVal;

    const maxComments = parseInt(document.getElementById('xhs-recommend-maxc').value) || 200;

    const endTimeStr = document.getElementById('xhs-recommend-end-time').value;
    let endTime = 0;
    if (endTimeStr) {
      endTime = new Date(endTimeStr).getTime();
      if (endTime <= Date.now()) {
        window.Toast && window.Toast.warn('结束时间必须晚于当前时间');
        return;
      }
    }

    const params = { videoKeywords, commentHours, maxComments, endTime };

    showProgress(true, 0, 0, 0);
    setRecommendRunning(true);
    await window.xhsAPI.xhsStartRecommend(params);
  }

  async function pauseRecommend() {
    await window.xhsAPI.xhsPauseRecommend();
    const btn = document.getElementById('xhs-btn-recommend-pause');
    btn.textContent = btn.textContent === '暂停' ? '继续' : '暂停';
  }

  async function stopRecommend() {
    await window.xhsAPI.xhsStopRecommend();
    setRecommendRunning(false);
    document.getElementById('xhs-btn-recommend-pause').textContent = '暂停';
    showProgress(false);
  }

  function setRecommendRunning(running) {
    recommendRunning = running;
    document.getElementById('xhs-btn-recommend-start').disabled = running;
    document.getElementById('xhs-btn-recommend-pause').disabled = !running;
    document.getElementById('xhs-btn-recommend-stop').disabled = !running;
  }

  function updateRecommendStatus(msg) {
    const el = document.getElementById('xhs-recommend-status');
    if (el) el.textContent = msg;

    if (msg.includes('完成') || msg.includes('停止') || msg.includes('失败')) {
      setRecommendRunning(false);
      document.getElementById('xhs-btn-recommend-pause').textContent = '暂停';
      document.getElementById('xhs-rp-status').textContent = msg.includes('完成') ? '已完成' : '已停止';
      document.getElementById('xhs-rp-bar').style.width = '100%';
    }
  }

  function applyProgress(p) {
    if (!p) return;
    const el = document.getElementById('xhs-recommend-progress');
    if (el) el.style.display = 'block';

    if (typeof p.videoCount === 'number') {
      document.getElementById('xhs-rp-video').textContent = `笔记: ${p.videoCount}`;
    }
    if (typeof p.cdpTotal === 'number') {
      document.getElementById('xhs-rp-comment').textContent = `评论: ${p.cdpTotal}`;
    }
    if (typeof p.matchedTotal === 'number') {
      document.getElementById('xhs-rp-match').textContent = `命中: ${p.matchedTotal}`;
    }
  }

  function showProgress(show) {
    const el = document.getElementById('xhs-recommend-progress');
    el.style.display = show ? 'block' : 'none';
    if (show) {
      document.getElementById('xhs-rp-video').textContent = '笔记: 0';
      document.getElementById('xhs-rp-comment').textContent = '评论: 0';
      document.getElementById('xhs-rp-match').textContent = '命中: 0';
      document.getElementById('xhs-rp-status').textContent = '运行中';
      document.getElementById('xhs-rp-bar').style.width = '0%';
    }
  }

  function addRecommendResult(result) {
    const container = document.getElementById('xhs-recommend-results');
    const item = document.createElement('div');
    item.className = 'result-item';
    const score = result.score || 0;
    const scoreClass = score >= 10 ? 'score-high' : score >= 5 ? 'score-mid' : 'score-low';
    const keywords = Array.isArray(result.matched_keywords) ? result.matched_keywords.join(',') : (result.matched_keywords || '');
    const videoKw = Array.isArray(result.video_keywords) ? result.video_keywords.join(',') : (result.video_keywords || '');
    item.innerHTML = `
      <div class="ri-header">
        <span class="ri-nick">${escapeHtml(result.nickname || '')}</span>
        <span class="ri-score ${scoreClass}">${score}分</span>
      </div>
      <div class="ri-comment">${escapeHtml(result.comment_text || '')}</div>
      <div class="ri-meta">意向词: ${escapeHtml(keywords)} | 笔记词: ${escapeHtml(videoKw)}</div>
    `;
    container.insertBefore(item, container.firstChild);
    while (container.children.length > 200) container.removeChild(container.lastChild);
  }

  function appendTaskLog(msg) {
    const el = document.getElementById('xhs-recommend-task-log');
    if (!el) return;
    const ts = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.style.cssText = 'white-space:pre-wrap;word-break:break-all;padding:1px 0;';
    if (msg.includes('异常') || msg.includes('失败') || msg.includes('错误')) line.style.color = '#f44336';
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
    document.addEventListener('DOMContentLoaded', initRecommend);
  } else {
    initRecommend();
  }
})();
