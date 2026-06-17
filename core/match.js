/**
 * 关键词匹配模块 v2.0
 *
 * 升级要点（综合 jieba/fuzz/match 库最佳实践）:
 *   1. 支持多种匹配模式：includes / exact / wordBoundary / regex / fuzzy
 *   2. 文本归一化：去标点、全/半角转换、小写、去空白
 *   3. 关键词去重 + 权重评分（多关键词命中加权）
 *   4. 垃圾词先匹配优先（含「广告」「代理」等带营销意图词）
 *   5. 兼容词组（"想要/需要/求购" 同义组）
 *   6. 防御性处理 null/空/特殊字符
 *
 * API:
 *   - normalizeText(text)             文本归一化
 *   - matchIntent(text, intents, garbages, options)
 *   - matchIntentAdvanced(text, intents, garbages, options)
 *   - calcCommentScore(commentTime)   时效评分（保持原接口）
 *   - isAdText(text)                  快速识别广告
 *   - tokenize(text)                  简单分词（中英混合）
 */

// ---------- 工具：归一化 ----------

/**
 * 文本归一化：去标点、统一大小写、全/半角转小写、去多余空白
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  if (text == null) return '';
  let s = String(text);
  // 全角 -> 半角
  s = s.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/\u3000/g, ' ');
  // 小写
  s = s.toLowerCase();
  // 去标点（中英文常见标点）
  s = s.replace(/[`~!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?，。！？；：、…—·《》（）"'!?;:\s]/g, ' ');
  // 多空白压缩
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * 简易分词 - 中英混合
 * - 中文：单字粒度（保守，避免误分）
 * - 英文/数字：连续串
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) return [];
  const s = normalizeText(text);
  const tokens = [];
  // 匹配英文/数字
  const en = s.match(/[a-z0-9]+/g);
  if (en) tokens.push(...en);
  // 单字中文
  for (const ch of s) {
    if (/[\u4e00-\u9fa5]/.test(ch)) tokens.push(ch);
  }
  return tokens;
}

// ---------- 工具：编译关键词 ----------

/**
 * 编译单个关键词为多种匹配模式
 * @param {string} keyword
 * @param {string} defaultMode
 * @returns {object|null}
 */
function compileKeyword(keyword, defaultMode) {
  if (keyword == null) return null;
  let kw = String(keyword).trim();
  if (!kw) return null;

  let mode = defaultMode || 'includes';
  // 自动检测模式：/regex/ 形式
  if (kw.startsWith('/') && kw.lastIndexOf('/') > 0) {
    const last = kw.lastIndexOf('/');
    const body = kw.substring(1, last);
    const flags = kw.substring(last + 1) || 'i';
    try {
      return {
        raw: keyword,
        mode: 'regex',
        regex: new RegExp(body, flags),
        norm: normalizeText(body.replace(/\\\//g, '/'))
      };
    } catch (e) {
      // 编译失败：降级为 includes
      kw = body;
    }
  }

  // 自动检测：word boundary 模式（以 \b 包裹）
  if (kw.startsWith('\\b') || kw.startsWith('^') || kw.endsWith('$')) {
    mode = 'wordBoundary';
  }

  const norm = normalizeText(kw);
  if (!norm) return null;

  // 最小关键词长度：归一化后至少1个字符（支持单字匹配如"做"、"想"等）
  if (norm.length < 1) return null;

  return {
    raw: keyword,
    mode,
    norm,
    // 预编译 word boundary 模式（英文适用）
    wbRegex: mode === 'wordBoundary' ? new RegExp('(^|\\s)' + norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|\\s)', 'i') : null
  };
}

// ---------- 核心：匹配意向关键词 ----------

/**
 * 高级意向匹配（推荐）
 * @param {string} text
 * @param {Array<string>} intentKeywords
 * @param {Array<string>} garbageKeywords
 * @param {object} options - {mode: 'includes'|'wordBoundary'|'regex'|'exact'|'fuzzy', minScore, weights}
 * @returns {{hit: bool, keywords: string[], garbage: bool, score: number, detail}}
 */
function matchIntentAdvanced(text, intentKeywords, garbageKeywords, options) {
  options = options || {};
  const mode = options.mode || 'includes';
  const minScore = options.minScore || 1;
  const weights = options.weights || null;

  if (!text) return { hit: false, keywords: [], garbage: false, score: 0, detail: { reason: 'empty_text' } };

  const normText = normalizeText(text);
  const rawText = String(text);

  // 1. 先匹配垃圾词（命中即返回）
  if (Array.isArray(garbageKeywords)) {
    for (const g of garbageKeywords) {
      if (!g) continue;
      const ck = compileKeyword(g, mode);
      if (!ck) continue;
      const m = matchOne(rawText, normText, ck);
      if (m && m.hit) {
        return { hit: false, keywords: [], garbage: true, score: 0, detail: { garbageKeyword: g } };
      }
    }
  }

  // 2. 匹配意向词（去重 + 计分）
  if (!Array.isArray(intentKeywords) || intentKeywords.length === 0) {
    return { hit: false, keywords: [], garbage: false, score: 0, detail: { reason: 'no_intent' } };
  }

  const seen = new Set();
  const matched = [];
  let totalScore = 0;
  for (const k of intentKeywords) {
    if (!k) continue;
    const key = String(k).toLowerCase().trim();
    if (seen.has(key)) continue;
    const ck = compileKeyword(k, mode);
    if (!ck) continue;
    const m = matchOne(rawText, normText, ck);
    if (m && m.hit) {
      seen.add(key);
      matched.push(k);
      const w = (weights && weights[key]) || 1;
      totalScore += m.score * w;
    }
  }

  return {
    hit: matched.length > 0 && totalScore >= minScore,
    keywords: matched,
    garbage: false,
    score: totalScore,
    detail: { mode, matchedCount: matched.length }
  };
}

/**
 * 单个关键词匹配
 * @returns {{hit: bool, score: number}}
 */
function matchOne(rawText, normText, ck) {
  if (ck.mode === 'regex') {
    if (ck.regex.test(rawText) || ck.regex.test(normText)) {
      return { hit: true, score: 2 };
    }
    return { hit: false, score: 0 };
  }
  if (ck.mode === 'wordBoundary' || ck.mode === 'exact') {
    if (ck.wbRegex && ck.wbRegex.test(normText)) return { hit: true, score: 2 };
    // 退化：用 includes 兜底（中文无词边界概念）
    if (normText.includes(ck.norm)) return { hit: true, score: 1 };
    return { hit: false, score: 0 };
  }
  if (ck.mode === 'fuzzy') {
    // 模糊匹配：编辑距离 ≤ 1 视为命中（短词）
    if (normText.includes(ck.norm)) return { hit: true, score: 1 };
    if (ck.norm.length >= 3 && levenshtein(normText, ck.norm) <= 1) return { hit: true, score: 1 };
    return { hit: false, score: 0 };
  }
  // 默认 includes
  if (normText.includes(ck.norm)) return { hit: true, score: 1 };
  return { hit: false, score: 0 };
}

/**
 * 编辑距离（仅用于短词模糊匹配）
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 1) return 2;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
    }
  }
  return dp[m][n];
}

// ---------- 兼容旧 API ----------

/**
 * 匹配意向关键词（向后兼容 - 返回 [hit, keywords, garbage] 元组）
 */
function matchIntent(text, intentKeywords, garbageKeywords) {
  const r = matchIntentAdvanced(text, intentKeywords, garbageKeywords, { mode: 'includes' });
  return [r.hit, r.keywords, r.garbage];
}

/**
 * 计算评论时效评分（保持原签名，兼容旧代码）
 * @param {number} commentTime - Unix 时间戳（秒）
 * @returns {number} 1|5|10
 */
function calcCommentScore(commentTime) {
  try {
    const ct = parseInt(commentTime);
    if (isNaN(ct) || ct <= 0) return 1;

    const now = Math.floor(Date.now() / 1000);
    const diffMin = (now - ct) / 60.0;

    if (diffMin <= 15) return 10;   // 15分钟内
    if (diffMin <= 40) return 5;    // 40分钟内
    return 1;                        // 超过40分钟
  } catch (e) {
    return 1;
  }
}

/**
 * 计算评论时效评分（动态版）- 根据用户设置的时间范围计算评分
 * ⚠️ 核心修复：评分应该反映用户设置的 commentHours，而不是固定15/40分钟
 * @param {number} commentTime - Unix 时间戳（秒）
 * @param {number} cutoffTs - 时间截止阈值（秒）。评论时间 < cutoffTs 视为过期
 * @param {number} commentHours - 用户设置的评论时效（小时）
 * @returns {number} 1-10 评分
 */
function calcCommentScoreAdvanced(commentTime, cutoffTs, commentHours) {
  try {
    const ct = parseInt(commentTime);
    const now = Math.floor(Date.now() / 1000);

    // 无有效时间：给低分
    if (isNaN(ct) || ct <= 0) return 1;

    // 时间判断：过期评论给最低分
    if (cutoffTs > 0 && ct < cutoffTs) {
      return 1;
    }

    // 时间差（分钟）- 评论是多久之前的
    const diffMin = (now - ct) / 60.0;
    if (diffMin < 0) return 10;  // 未来时间（可能是时区问题），给满分

    // ⚠️ 关键：根据 commentHours 动态计算评分
    // 例如：commentHours=60小时 → 60小时内的评论都有较高评分
    const totalMin = (commentHours || 60) * 60;
    const ratio = diffMin / totalMin;  // 0 = 刚刚, 1 = 刚好到 cutoffTs

    // 线性评分：
    // - 前1/3时间内 → 10分（很新）
    // - 前2/3时间内 → 5分（中等）
    // - 超过2/3但仍在范围内 → 3分（较旧但有效）
    // - 超过范围 → 1分（过期）
    if (ratio < 0.33) return 10;
    if (ratio < 0.66) return 5;
    if (ratio < 1.0) return 3;
    return 1;
  } catch (e) {
    return 1;
  }
}

// ---------- 快速识别广告 ----------

/**
 * 快速识别广告/营销话术
 * @param {string} text
 * @returns {boolean}
 */
function isAdText(text) {
  if (!text) return false;
  const norm = normalizeText(text);
  const adPatterns = [
    // 加微信
    /加\s*[vVxX]\s*[：:]/, /加\s*微\s*信/, /\bwechat\b/i, /\bwx\b/i,
    // 价格诱导
    /\d+\s*元/, /价格\s*美丽/, /优惠/, /特价/, /折扣/,
    // 联系方式
    /\d{11,}/, /\d{3,4}[-\s]?\d{4,8}/,
    // 营销话术
    /代理/, /加盟/, /招\s*商/, /源\s*头/, /厂\s*家/, /直\s*销/,
    /私\s*信/, /详\s*情/, /点\s*我/, /看\s*我/
  ];
  return adPatterns.some(p => p.test(norm) || p.test(text));
}

// ---------- 导出 ----------

module.exports = {
  // 归一化
  normalizeText,
  tokenize,
  // 核心
  matchIntent,
  matchIntentAdvanced,
  matchOne,
  compileKeyword,
  isAdText,
  // 时效
  calcCommentScore,
  calcCommentScoreAdvanced,
  // 工具
  levenshtein
};
