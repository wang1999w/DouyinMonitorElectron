/**
 * API 响应解析模块
 * 从 Electron 拦截到的请求 URL 和响应头中提取视频/评论数据
 * 对应原 Python 项目的 scraper/interceptor.py
 */

/**
 * 抖音 API URL 匹配规则
 */
const URL_PATTERNS = {
  search: ['/web/general/search/single/', '/web/search/item/', '/search/'],
  video: ['/aweme/post', '/recommend/'],
  comment: ['/comment/list', '/comment/']
};

/**
 * 解析请求 URL 中的查询参数
 * @param {string} url - 请求 URL
 * @returns {Object} 查询参数键值对
 */
function parseQueryString(url) {
  try {
    const u = new URL(url);
    const params = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    return params;
  } catch (e) {
    return {};
  }
}

/**
 * 判断 URL 类型
 * @param {string} url - 请求 URL
 * @returns {string|null} 'search'|'video'|'comment'|null
 */
function classifyUrl(url) {
  for (const [type, patterns] of Object.entries(URL_PATTERNS)) {
    for (const p of patterns) {
      if (url.includes(p)) return type;
    }
  }
  return null;
}

/**
 * 从请求信息中提取 aweme_id（视频ID）
 * @param {string} url - 请求 URL
 * @returns {string}
 */
function extractAwemeId(url) {
  const params = parseQueryString(url);
  return params.aweme_id || params.awemeId || '';
}

/**
 * 构建请求摘要信息
 * 用于 Network 面板展示和日志记录
 * @param {Object} details - webRequest onCompleted 的 details 对象
 * @returns {Object} 请求摘要
 */
function buildRequestSummary(details) {
  const urlType = classifyUrl(details.url);
  const awemeId = extractAwemeId(details.url);

  return {
    id: Date.now() + Math.random(),
    url: details.url,
    method: details.method,
    statusCode: details.statusCode,
    timestamp: new Date().toLocaleTimeString(),
    type: urlType,
    awemeId,
    responseHeaders: details.responseHeaders
  };
}

module.exports = {
  parseQueryString,
  classifyUrl,
  extractAwemeId,
  buildRequestSummary,
  URL_PATTERNS
};
