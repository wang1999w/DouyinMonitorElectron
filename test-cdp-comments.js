// 测试：直接读取CDP拦截到的评论数据
const http = require('http');

function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 18911,
      path: path,
      method: 'GET',
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
    req.end();
  });
}

async function main() {
  try {
    // 获取CDP评论数据
    const result = await apiRequest('/api/xhs/comments?noteId=69fefd0f0000000035028cb4');
    console.log('CDP评论:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
