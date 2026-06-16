// 测试意向词匹配
const match = require('./core/match');

// 从config加载意向词
const config = require('./core/config').loadConfig();
const intentKw = config.xhs_search_intent_keywords || [];
const garbageKw = config.xhs_search_garbage_keywords || [];

console.log('意向词数量:', intentKw.length);
console.log('前10个意向词:', intentKw.slice(0, 10));
console.log('垃圾词:', garbageKw);

// 测试一些真实评论
const testComments = [
  '湖北有没有张倩倩的',
  '我这个怎么样',
  '想做双眼皮好久了',
  '多少钱啊',
  '哪里做的呀',
  '效果怎么样',
  '太好看啦',
  '关注了',
  '求推荐医生',
  '贵吗',
  '自然吗',
  '哪家医院好',
  '想问下恢复期多久',
  '做',
  '想',
  '多少钱',
  '咨询一下'
];

console.log('\n--- 匹配测试 ---');
for (const text of testComments) {
  const [hit, keywords, garbage] = match.matchIntent(text, intentKw, garbageKw);
  const status = garbage ? 'GARBAGE' : (hit ? `HIT[${keywords.join(',')}]` : 'MISS');
  console.log(`  "${text}" -> ${status}`);
}

// 测试归一化
console.log('\n--- 归一化测试 ---');
for (const text of ['多少钱', '咨询', '想做', '做', '想']) {
  const norm = match.normalizeText(text);
  console.log(`  "${text}" -> "${norm}" (len=${norm.length})`);
}

// 测试compileKeyword
console.log('\n--- compileKeyword测试 ---');
for (const kw of ['做', '想', '多少', '哪里', '咨询', '多少钱']) {
  const ck = match.compileKeyword(kw, 'includes');
  console.log(`  "${kw}" -> ${ck ? JSON.stringify({norm: ck.norm, mode: ck.mode}) : 'null'}`);
}
