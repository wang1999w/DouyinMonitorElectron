/**
 * 小红书设置面板
 */

(function () {
  function initSettings() {
    document.getElementById('xhs-btn-save-kw').addEventListener('click', saveKeywords);
    document.getElementById('xhs-btn-export').addEventListener('click', exportResults);
  }

  async function saveKeywords() {
    const cfg = await window.xhsAPI.getConfig();
    cfg.xhs_search_intent_keywords = getTextarea('xhs-intent-kw');
    cfg.xhs_search_garbage_keywords = getTextarea('xhs-garbage-kw');
    await window.xhsAPI.saveConfig(cfg);
    window.Toast && window.Toast.success('小红书关键词已保存');
  }

  async function exportResults() {
    window.Toast && window.Toast.info('导出功能开发中...');
  }

  function getTextarea(id) {
    const el = document.getElementById(id);
    if (!el) return [];
    return el.value.split('\n').map(s => s.trim()).filter(Boolean);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSettings);
  } else {
    initSettings();
  }
})();
