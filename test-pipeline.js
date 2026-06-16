// 测试：模拟noteProcessor的完整匹配流程
const pipeline = require('./core/pipeline');
const config = require('./core/config').loadConfig();

const intentKw = config.xhs_search_intent_keywords || [];
const garbageKw = config.xhs_search_garbage_keywords || [];

console.log('意向词数量:', intentKw.length);
console.log('垃圾词数量:', garbageKw.length);

// 模拟CDP评论数据（来自实际API返回）
const cdpComments = [
  { comment_id: '1', text: '兩個月了，朋友都说我像变了个人[害羞R]', nickname: '琳lin', uid: '1', create_time: 1781167536, ip_label: '广东', platform: 'xhs', note_id: 'test' },
  { comment_id: '2', text: '四十多天又能美美化妆了[偷笑R]', nickname: '胡锦瑜', uid: '2', create_time: 1781175895, ip_label: '广东', platform: 'xhs', note_id: 'test' },
  { comment_id: '3', text: '耿继龙那处理肿眼泡还不错', nickname: '饼干', uid: '3', create_time: 1781604736, ip_label: '安徽', platform: 'xhs', note_id: 'test' },
  { comment_id: '5', text: '湖北有没有张倩倩的', nickname: '明鱼子', uid: '5', create_time: 1781261940, ip_label: '北京', platform: 'xhs', note_id: 'test' },
  { comment_id: '6', text: '蹲个成都的，暑假有去找黄元利的不？', nickname: '后天见', uid: '6', create_time: 1781503834, ip_label: '四川', platform: 'xhs', note_id: 'test' },
  { comment_id: '7', text: '合肥谁比较好呀', nickname: '米奇妙妙', uid: '7', create_time: 1781515218, ip_label: '安徽', platform: 'xhs', note_id: 'test' },
];

const videoInfo = { aweme_id: 'test', desc: '双眼皮', author: 'test', video_url: 'https://test' };
const keywords = { intent: intentKw, garbage: garbageKw };

console.log('\n--- 模拟processComment ---');
let matched = 0;
for (const c of cdpComments) {
  const result = pipeline.processComment(c, null, videoInfo, keywords);
  if (result) {
    matched++;
    console.log(`  HIT: "${c.text.slice(0, 30)}" -> ${result.matched_keywords}`);
  } else {
    console.log(`  MISS: "${c.text.slice(0, 30)}"`);
  }
}
console.log(`\n总命中: ${matched}/${cdpComments.length}`);
