/**
 * 小红书 Network 面板逻辑
 */

(function () {
  const MAX_REQUESTS = 500;
  let requests = [];

  function initNetwork() {
    const listEl = document.getElementById('xhs-network-list');
    const filterEl = document.getElementById('xhs-network-filter');
    const clearBtn = document.getElementById('xhs-network-clear');

    window.xhsAPI.onXhsRequestData && window.xhsAPI.onXhsRequestData((data) => {
      requests.unshift(data);
      if (requests.length > MAX_REQUESTS) requests = requests.slice(0, MAX_REQUESTS);
      renderRequest(data);
    });

    filterEl.addEventListener('input', () => {
      filterRequests(filterEl.value);
    });

    clearBtn.addEventListener('click', () => {
      requests = [];
      listEl.innerHTML = '';
    });
  }

  function renderRequest(data) {
    const listEl = document.getElementById('xhs-network-list');
    const filterEl = document.getElementById('xhs-network-filter');
    if (filterEl.value && !data.url.toLowerCase().includes(filterEl.value.toLowerCase())) return;

    const item = document.createElement('div');
    item.className = 'request-item';
    const methodClass = `req-${(data.method || 'GET').toLowerCase()}`;
    const statusClass = `status-${String(data.statusCode).charAt(0)}xx`;
    item.innerHTML = `
      <span class="req-method ${methodClass}">${data.method || 'GET'}</span>
      <span class="req-status ${statusClass}">${data.statusCode || '--'}</span>
      <span class="req-time">${data.timestamp || ''}</span>
      <span class="req-url">${truncUrl(data.url)}</span>
    `;
    item.title = data.url;
    if (listEl.firstChild) listEl.insertBefore(item, listEl.firstChild);
    else listEl.appendChild(item);
    while (listEl.children.length > MAX_REQUESTS) listEl.removeChild(listEl.lastChild);
  }

  function filterRequests(keyword) {
    const listEl = document.getElementById('xhs-network-list');
    const items = listEl.querySelectorAll('.request-item');
    const lower = keyword.toLowerCase();
    items.forEach((item, i) => {
      const url = requests[i] ? requests[i].url.toLowerCase() : '';
      item.style.display = url.includes(lower) ? '' : 'none';
    });
  }

  function truncUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      let display = u.pathname + u.search;
      if (display.length > 80) display = display.substring(0, 80) + '...';
      return u.hostname + display;
    } catch (e) {
      return url.length > 100 ? url.substring(0, 100) + '...' : url;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNetwork);
  } else {
    initNetwork();
  }
})();
