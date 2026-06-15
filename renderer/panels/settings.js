/**
 * 设置面板
 * 负责：邮件/企微配置、关键词管理、数据导出
 */

(function () {
  /**
   * 初始化设置面板事件
   */
  function initSettings() {
    // 邮件设置
    document.getElementById('btn-save-email').addEventListener('click', saveEmailSettings);
    document.getElementById('btn-test-email').addEventListener('click', testEmail);

    // 企微设置
    document.getElementById('btn-save-wechat').addEventListener('click', saveWechatSettings);
    document.getElementById('btn-test-wechat').addEventListener('click', testWechat);

    // 关键词设置
    document.getElementById('btn-save-search-kw').addEventListener('click', saveSearchKeywords);

    // 导出
    document.getElementById('btn-export').addEventListener('click', exportResults);
  }

  /**
   * 保存邮件配置
   */
  async function saveEmailSettings() {
    const cfg = await window.electronAPI.getConfig();
    cfg.email = {
      enable: document.getElementById('email-enable').checked,
      smtp_server: document.getElementById('email-smtp').value.trim(),
      smtp_port: parseInt(document.getElementById('email-port').value) || 465,
      sender: document.getElementById('email-sender').value.trim(),
      auth_code: document.getElementById('email-auth').value.trim(),
      receivers: document.getElementById('email-receivers').value.trim()
    };
    await window.electronAPI.saveConfig(cfg);
    window.Toast && window.Toast.success('邮件设置已保存');
  }

  /**
   * 发送测试邮件
   */
  async function testEmail() {
    const result = await window.electronAPI.sendTestEmail();
    if (result.success) {
      window.Toast && window.Toast.success('测试邮件发送成功');
    } else {
      window.Toast && window.Toast.error('发送失败: ' + (result.error || '未知错误'));
    }
  }

  /**
   * 保存企业微信配置
   */
  async function saveWechatSettings() {
    const cfg = await window.electronAPI.getConfig();
    cfg.wechat = {
      enable: document.getElementById('wechat-enable').checked,
      webhook_url: document.getElementById('wechat-url').value.trim()
    };
    await window.electronAPI.saveConfig(cfg);
    window.Toast && window.Toast.success('企微设置已保存');
  }

  /**
   * 发送企微测试消息
   */
  async function testWechat() {
    const result = await window.electronAPI.sendTestWechat();
    if (result.success) {
      window.Toast && window.Toast.success('企微测试消息发送成功');
    } else {
      window.Toast && window.Toast.error('发送失败: ' + (result.error || '未知错误'));
    }
  }

  /**
   * 保存搜索关键词
   */
  async function saveSearchKeywords() {
    const cfg = await window.electronAPI.getConfig();
    cfg.search_intent_keywords = getTextarea('search-intent-kw');
    cfg.search_garbage_keywords = getTextarea('search-garbage-kw');
    await window.electronAPI.saveConfig(cfg);
    window.Toast && window.Toast.success('搜索关键词已保存');
  }

  /**
   * 导出意向评论到 Excel
   */
  async function exportResults() {
    const result = await window.electronAPI.exportResults();
    if (result.success) {
      window.Toast && window.Toast.success('导出成功: ' + result.path);
    } else if (result.error) {
      window.Toast && window.Toast.error('导出失败: ' + result.error);
    }
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
    document.addEventListener('DOMContentLoaded', initSettings);
  } else {
    initSettings();
  }
})();
