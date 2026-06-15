/**
 * 意向关键词匹配模块
 * 从 Python utils/match.py 逐行翻译，逻辑完全一致
 * 功能：判断评论是否命中意向关键词，计算评论时效评分
 */

/**
 * 匹配意向关键词
 * 先检查垃圾关键词（命中则直接返回），再检查意向关键词
 * @param {string} text - 评论文本
 * @param {Array<string>} intentKeywords - 意向关键词列表
 * @param {Array<string>} garbageKeywords - 垃圾关键词列表
 * @returns {Array} [是否命中, 命中的关键词列表, 是否为垃圾评论]
 */
function matchIntent(text, intentKeywords, garbageKeywords) {
  if (!text) return [false, [], false];

  const lowerText = text.toLowerCase();

  // 先检查垃圾关键词
  for (const g of garbageKeywords) {
    if (g.toLowerCase().includes(lowerText) || lowerText.includes(g.toLowerCase())) {
      return [false, [], true];
    }
  }

  // 再检查意向关键词
  const matched = intentKeywords.filter(k =>
    lowerText.includes(k.toLowerCase())
  );

  return [matched.length > 0, matched, false];
}

/**
 * 计算评论时效评分
 * 根据评论发布时间与当前时间的差值打分
 * @param {number} commentTime - 评论时间（Unix 时间戳，秒）
 * @returns {number} 评分：10=时效评论，5=近期评论，1=历史评论
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

module.exports = { matchIntent, calcCommentScore };
