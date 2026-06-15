/**
 * Network 面板逻辑
 * 负责：接收拦截到的请求数据、渲染请求列表、过滤、清空
 */

(function () {
  const MAX_REQUESTS = 500;
  let requests = [];

  /**
   * 初始化 Network 面板
   */
  function initNetwork() {
    const listEl = document.getElementById('network-list');
    const filterEl = document.getElementById('network-filter');
    const clearBtn = document.getElementById('network-clear');
    const autoScrollEl = document.getElementById('network-auto-scroll');

    // 监听主进程发来的请求数据
    window.electronAPI.onRequestData((data) => {
      requests.unshift(data);
      if (requests.length > MAX_REQUESTS) {
        requests = requests.slice(0, MAX_REQUESTS);
      }
      renderRequest(data);
    });

    // URL 过滤
    filterEl.addEventListener('input', () => {
      filterRequests(filterEl.value);
    });

    // 清空列表
    clearBtn.addEventListener('click', () => {
      requests = [];
      listEl.innerHTML = '';
    });
  }

  /**
   * 渲染单条请求到列表
   * @param {Object} data - 请求数据
   */
  function renderRequest(data) {
    const listEl = document.getElementById('network-list');
    const filterEl = document.getElementById('network-filter');

    // 检查过滤条件
    if (filterEl.value && !data.url.toLowerCase().includes(filterEl.value.toLowerCase())) {
      return;
    }

    const item = document.createElement('div');
    item.className = 'request-item';

    const methodClass = `req-${(data.method || 'GET').toLowerCase()}`;
    const statusClass = `status-${String(data.statusCode).charAt(0)}xx`;

    item.innerHTML = `
      <span class="req-method ${methodClass}">${data.method || 'GET'}</span>
      <span class="req-status ${statusClass}">${data.statusCode || '--'}</span>
      <span class="req-time">${data.timestamp}</span>
      <span class="req-url">${truncUrl(data.url)}</span>
    `;

    item.title = data.url;

    // 插入到列表顶部
    if (listEl.firstChild) {
      listEl.insertBefore(item, listEl.firstChild);
    } else {
      listEl.appendChild(item);
    }

    // 限制 DOM 节点数
    while (listEl.children.length > MAX_REQUESTS) {
      listEl.removeChild(listEl.lastChild);
    }

    // 自动滚动
    const autoScroll = document.getElementById('network-auto-scroll');
    if (autoScroll && autoScroll.checked) {
      listEl.scrollTop = 0;
    }
  }

  /**
   * 根据关键词过滤请求列表
   * @param {string} keyword - 过滤关键词
   */
  function filterRequests(keyword) {
    const listEl = document.getElementById('network-list');
    const items = listEl.querySelectorAll('.request-item');
    const lower = keyword.toLowerCase();

    items.forEach((item, i) => {
      const url = requests[i] ? requests[i].url.toLowerCase() : '';
      item.style.display = url.includes(lower) ? '' : 'none';
    });
  }

  /**
   * 截断过长的 URL 显示
   * @param {string} url - 原始 URL
   * @returns {string} 截断后的 URL
   */
  function truncUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      let display = u.pathname + u.search;
      if (display.length > 80) {
        display = display.substring(0, 80) + '...';
      }
      return u.hostname + display;
    } catch (e) {
      return url.length > 100 ? url.substring(0, 100) + '...' : url;
    }
  }

  // DOM 加载后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNetwork);
  } else {
    initNetwork();
  }
})();
