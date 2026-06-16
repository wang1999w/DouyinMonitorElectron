/**
 * 抖音页面结构自探查器 v1.0
 *
 * 用法：调用 dumpDouyinStructure(view, 'search_results') 让应用把当前页面的关键结构
 * 写入 logs/douyin-structure-*.json，再读取后用于定位器调优。
 *
 * 重要：未经实地探测，定位器只是猜测。运行一次 dump 即可知道真实 DOM。
 */

const fs = require('fs');
const path = require('path');
const { getLogger } = require('./logger');
const logger = getLogger('PageInspector');

const DUMP_DIR = path.join(process.cwd(), 'logs', 'page-dumps');

function ensureDumpDir() {
  if (!fs.existsSync(DUMP_DIR)) {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
  }
}

/**
 * 转义 JS 字符串
 */
function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * 探测抖音搜索结果页结构
 * 输出: { url, title, viewport, tabs: [...], searchBar: {...}, filterBar: {...} }
 */
async function dumpDouyinStructure(view, scenario = 'unknown') {
  ensureDumpDir();
  const wc = view.webContents;

  const script = `(function(){
    function elInfo(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().substring(0, 80),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        attrs: {
          'data-e2e': el.getAttribute('data-e2e') || '',
          role: el.getAttribute('role') || '',
          'aria-label': el.getAttribute('aria-label') || '',
          href: (el.getAttribute('href') || '').substring(0, 100),
          class: (el.className || '').toString().substring(0, 100)
        }
      };
    }

    function findAll(selector) {
      const out = [];
      document.querySelectorAll(selector).forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push(elInfo(el));
      });
      return out;
    }

    // 1. 顶部 tabs：找所有可能的 tab 容器
    const tabCandidates = [];
    document.querySelectorAll('[role="tab"], [class*="tab" i], [class*="Tab"]').forEach(el => {
      const info = elInfo(el);
      if (info && info.rect.y < 300) tabCandidates.push(info);
    });

    // 2. 顶部 1-200 区域所有可见元素（前 200 个）
    const topElements = [];
    let count = 0;
    document.querySelectorAll('span, div, a, button').forEach(el => {
      if (count >= 200) return;
      if (el.children.length > 0) return;
      const r = el.getBoundingClientRect();
      if (r.y < 200 && r.x < 1300 && r.width > 5 && r.height > 5) {
        const t = (el.innerText || el.textContent || '').trim();
        if (t && t.length < 30) {
          topElements.push(elInfo(el));
          count++;
        }
      }
    });

    // 3. 搜索栏
    const searchInput = document.querySelector('input[data-e2e="searchbar-input"], input[placeholder*="搜索" i]');
    const searchBtn = document.querySelector('[data-e2e="searchbar-button"]');

    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
      searchBar: {
        input: elInfo(searchInput),
        button: elInfo(searchBtn)
      },
      tabCandidates: tabCandidates.slice(0, 30),
      topElements: topElements.slice(0, 80)
    };
  })()`;

  try {
    const data = await wc.executeJavaScript(script);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(DUMP_DIR, `douyin-${scenario}-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    logger.info(`[PageInspector] Dumped structure: ${file}`);
    return { file, data };
  } catch (e) {
    logger.error(`[PageInspector] dump failed: ${e.message}`);
    return { error: e.message };
  }
}

/**
 * 探测当前页面的所有可点击按钮（带文本和坐标）
 */
async function dumpClickableElements(view) {
  const wc = view.webContents;
  const script = `(function(){
    const out = [];
    document.querySelectorAll('button, a, [role="button"], [class*="btn" i], [data-e2e]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const t = (el.innerText || el.textContent || '').trim();
      if (!t || t.length > 50) return;
      out.push({
        tag: el.tagName.toLowerCase(),
        text: t,
        x: Math.round(r.x + r.width/2),
        y: Math.round(r.y + r.height/2),
        w: Math.round(r.width),
        h: Math.round(r.height),
        dataE2E: el.getAttribute('data-e2e') || '',
        role: el.getAttribute('role') || ''
      });
    });
    return { count: out.length, items: out.slice(0, 50), viewport: { w: window.innerWidth, h: window.innerHeight } };
  })()`;

  try {
    const data = await wc.executeJavaScript(script);
    return data;
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { dumpDouyinStructure, dumpClickableElements, DUMP_DIR };
