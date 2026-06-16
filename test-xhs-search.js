// XHS搜索测试脚本 - 用"双眼皮"关键词测试全链路
const http = require('http');

function apiRequest(path, data, method = 'POST') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 18911,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve({ raw: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function main() {
  try {
    // 1. 先创建小红书窗口
    console.log('1. 创建小红书窗口...');
    const switchResult = await apiRequest('/api/switch-platform', { platform: 'xhs' });
    console.log('   结果:', JSON.stringify(switchResult));

    // 2. 等待窗口加载
    console.log('2. 等待小红书窗口加载 (15秒)...');
    await new Promise(r => setTimeout(r, 15000));

    // 3. 发起搜索
    console.log('3. 发起搜索: 关键词="双眼皮", maxNotes=2');
    const searchResult = await apiRequest('/api/xhs/search/start', { keyword: '双眼皮', maxNotes: 2 });
    console.log('   结果:', JSON.stringify(searchResult, null, 2));

    // 4. 等待搜索执行
    console.log('4. 等待搜索执行 (60秒)...');
    await new Promise(r => setTimeout(r, 60000));

    // 5. 查看搜索状态
    console.log('5. 查看搜索状态...');
    const status = await apiRequest('/api/xhs/search/status', {});
    console.log('   状态:', JSON.stringify(status, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
