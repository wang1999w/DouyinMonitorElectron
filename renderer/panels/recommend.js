/**
 * 推荐页浏览面板
 * 视频关键词匹配、自动播放浏览、评论区采集
 */

(function () {
  let recommendRunning = false;

  function initRecommend() {
    document.getElementById('btn-recommend-start').addEventListener('click', startRecommend);
    document.getElementById('btn-recommend-pause').addEventListener('click', pauseRecommend);
    document.getElementById('btn-recommend-stop').addEventListener('click', stopRecommend);

    // 监听日志
    window.electronAPI.onRecommendLog && window.electronAPI.onRecommendLog((msg) => {
      updateRecommendStatus(msg);
      appendTaskLog('recommend', msg);
    });

    // 监听结果
    window.electronAPI.onRecommendResult && window.electronAPI.onRecommendResult((result) => {
      addRecommendResult(result);
    });

    // 监听进度
    window.electronAPI.onRecommendProgress && window.electronAPI.onRecommendProgress((p) => {
      applyProgress(p);
    });

    // ★ 监听任务完成事件（权威状态更新）— 无论正常/异常/停止都会触发
    if (window.electronAPI.onRecommendCompleted) {
      window.electronAPI.onRecommendCompleted((info) => {
        setRecommendRunning(false);
        document.getElementById('btn-recommend-pause').textContent = '暂停';
        const statusEl = document.getElementById('rp-status');
        if (statusEl) statusEl.textContent = info && info.success ? '已完成' : '已停止';
        const barEl = document.getElementById('rp-bar');
        if (barEl) barEl.style.width = '100%';
        appendTaskLog('recommend', (info && info.success === false && info.reason === 'error')
          ? `❌ 推荐浏览任务失败: ${info.message || '未知错误'}`
          : (info && info.reason === 'user_stopped' ? '🛑 推荐浏览任务已停止' : '✅ 推荐浏览任务已完成'));
      });
    }

    // 设置结束时间默认值（当前时间+1小时）
    const now = new Date();
    now.setHours(now.getHours() + 1);
    const defaultEnd = now.toISOString().slice(0, 16);
    document.getElementById('recommend-end-time').value = defaultEnd;
  }

  async function startRecommend() {
    const rawKw = document.getElementById('recommend-video-kw').value.trim();
    if (!rawKw) { window.Toast && window.Toast.warn('请输入视频关键词'); return; }

    const videoKeywords = rawKw.split('\n').map(s => s.trim()).filter(Boolean);
    if (videoKeywords.length === 0) { window.Toast && window.Toast.warn('请输入有效关键词'); return; }

    const chVal = parseInt(document.getElementById('recommend-ch').value) || 60;
    const chUnit = parseInt(document.getElementById('recommend-ch-unit').value) || 1;
    const commentHours = chVal * chUnit;

    const maxComments = parseInt(document.getElementById('recommend-maxc').value) || 200;

    // 结束时间
    const endTimeStr = document.getElementById('recommend-end-time').value;
    let endTime = 0;
    if (endTimeStr) {
      endTime = new Date(endTimeStr).getTime();
      if (endTime <= Date.now()) {
        window.Toast && window.Toast.warn('结束时间必须晚于当前时间');
        return;
      }
    }

    const params = {
      videoKeywords,
      commentHours,
      maxComments,
      endTime
    };

    showProgress(true, 0, 0, 0);
    setRecommendRunning(true);
    await window.electronAPI.startRecommend(params);
  }

  async function pauseRecommend() {
    try {
      await Promise.race([
        window.electronAPI.pauseRecommend(),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    } catch (e) { console.warn('pauseRecommend:', e); }
    const btn = document.getElementById('btn-recommend-pause');
    btn.textContent = btn.textContent === '暂停' ? '继续' : '暂停';
  }

  async function stopRecommend() {
    setRecommendRunning(false);
    document.getElementById('btn-recommend-pause').textContent = '暂停';
    showProgress(false);
    try {
      await Promise.race([
        window.electronAPI.stopRecommend(),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
    } catch (e) { console.warn('stopRecommend IPC error:', e); }
  }

  function setRecommendRunning(running) {
    recommendRunning = running;
    document.getElementById('btn-recommend-start').disabled = running;
    document.getElementById('btn-recommend-pause').disabled = !running;
    document.getElementById('btn-recommend-stop').disabled = !running;
  }

  function updateRecommendStatus(msg) {
    const el = document.getElementById('recommend-status');
    if (el) el.textContent = msg;

    // ★ 修复：只对任务级状态消息禁用按钮，不对普通日志禁用
    if (msg.includes('推荐浏览任务已完成') || msg.includes('推荐浏览任务已停止') || msg.includes('推荐浏览任务失败')) {
      setRecommendRunning(false);
      document.getElementById('btn-recommend-pause').textContent = '暂停';
      document.getElementById('rp-status').textContent = msg.includes('完成') ? '已完成' : '已停止';
      document.getElementById('rp-bar').style.width = '100%';
    }
  }

  function applyProgress(p) {
    if (!p) return;
    const el = document.getElementById('recommend-progress');
    if (el) el.style.display = 'block';

    if (typeof p.videoCount === 'number') {
      document.getElementById('rp-video').textContent = `视频: ${p.videoCount}`;
    }
    if (typeof p.cdpTotal === 'number' || typeof p.domTotal === 'number') {
      const cdp = p.cdpTotal || 0;
      const dom = p.domTotal || 0;
      document.getElementById('rp-comment').textContent = `评论: ${cdp + dom}`;
    }
    if (typeof p.matchedTotal === 'number') {
      document.getElementById('rp-match').textContent = `命中: ${p.matchedTotal}`;
    }
  }

  function showProgress(show, videoCount, comments, matchCount) {
    const el = document.getElementById('recommend-progress');
    el.style.display = show ? 'block' : 'none';
    if (show) {
      document.getElementById('rp-video').textContent = `视频: ${videoCount || 0}`;
      document.getElementById('rp-comment').textContent = `评论: ${comments || 0}`;
      document.getElementById('rp-match').textContent = `命中: ${matchCount || 0}`;
      document.getElementById('rp-status').textContent = '运行中';
      document.getElementById('rp-bar').style.width = '0%';
    }
  }

  function addRecommendResult(result) {
    const container = document.getElementById('recommend-results');
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
      <div class="ri-meta">意向词: ${escapeHtml(keywords)} | 视频词: ${escapeHtml(videoKw)} | 博主: ${escapeHtml(result.video_author || '')}</div>
    `;
    container.insertBefore(item, container.firstChild);
    while (container.children.length > 200) container.removeChild(container.lastChild);
  }

  function appendTaskLog(type, msg) {
    const logId = 'recommend-task-log';
    const countId = 'recommend-log-count';
    const el = document.getElementById(logId);
    if (!el) return;
    const ts = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.style.cssText = 'white-space:pre-wrap;word-break:break-all;padding:1px 0;';
    if (msg.includes('异常') || msg.includes('失败') || msg.includes('错误')) {
      line.style.color = '#f44336';
    } else if (msg.includes('完成') || msg.includes('成功') || msg.includes('✅')) {
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
