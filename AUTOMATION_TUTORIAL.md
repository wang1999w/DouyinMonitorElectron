# 自动化测试使用教程

## 一键自动化测试

### 步骤 1：准备工作
1. 已登录抖音账号（左侧浏览器面板）
2. 至少添加 1 个监控博主
3. 配置好全局意向关键词（如：价格、咨询、怎么买）

### 步骤 2：启动测试
在主界面点击"自动化测试"按钮，或调用 HTTP API：

```bash
curl -X POST http://127.0.0.1:18911/api/search/start \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": ["价格", "咨询"],
    "sortEnabled": true,
    "maxVideos": 10,
    "commentHours": 72
  }'
```

### 步骤 3：监控进度
```bash
# 实时状态
watch -n 2 'curl -s http://127.0.0.1:18911/api/status | jq'

# 或在 UI 中查看
# 搜索 → 进度条
# 监控 → 任务日志
```

### 步骤 4：停止测试
```bash
curl -X POST http://127.0.0.1:18911/api/search/stop
```

---

## 自动化场景示例

### 场景 1：每日定时采集
**目标**：每天 09:00 / 14:00 / 20:00 自动搜索意向

**步骤**：
1. 配置 → 自动化设置
2. 启用"定时搜索"
3. 设置间隔：5 小时（18000 秒）
4. 保存

应用启动后会自动按间隔执行，无需人工干预。

### 场景 2：多博主轮询监控
**目标**：每小时轮询所有启用的博主

**步骤**：
1. 配置 → 自动化设置
2. 启用"定时监控"
3. 设置间隔：3600 秒
4. 保存

### 场景 3：实时告警推送
**目标**：抓到意向立即推送到企微/邮件

**步骤**：
1. 配置 → 通知设置
2. 启用邮件 / 企微
3. 填写 SMTP / Webhook
4. 测试推送
5. 启用应用

抓到意向后 1-2 秒内会收到推送。

### 场景 4：远程控制
**目标**：在办公室/手机上控制家里的电脑

**步骤**：
1. 部署到一台一直开机的电脑
2. 修改 `main.js` 中 `host: '127.0.0.1'` → `'0.0.0.0'`
3. 配置端口转发或内网穿透（frp / 花生壳）
4. 任何能访问该 IP 的设备均可调用 HTTP API

```bash
# 远程启动搜索
curl -X POST http://your-domain:18911/api/search/start -d '...'

# 远程停止
curl -X POST http://your-domain:18911/api/search/stop

# 远程查看意向
curl http://your-domain:18911/api/leads
```

---

## HTTP API 完整示例

### Python 客户端
```python
import requests

BASE = "http://127.0.0.1:18911"

# 启动搜索
r = requests.post(f"{BASE}/api/search/start", json={
    "keywords": ["价格", "咨询", "怎么买"],
    "sortEnabled": True,
    "maxVideos": 50,
    "commentHours": 168  # 7天
})
print(r.json())

# 等待任务完成
import time
while True:
    state = requests.get(f"{BASE}/api/state").json()["state"]
    if state == "idle":
        break
    time.sleep(10)

# 导出意向
r = requests.get(f"{BASE}/api/leads/export")
print("导出:", r.json())

# 查看最新意向
r = requests.get(f"{BASE}/api/leads", params={"limit": 50})
for lead in r.json()["leads"]:
    print(lead["nickname"], ":", lead["comment_text"])
```

### Node.js 客户端
```javascript
const http = require('http');

function api(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: 18911,
      path,
      method,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // 启动搜索
  await api('/api/search/start', 'POST', {
    keywords: ['价格'],
    sortEnabled: true,
    maxVideos: 20
  });

  // 等待完成
  while (true) {
    const s = await api('/api/state');
    if (s.state === 'idle') break;
    await new Promise(r => setTimeout(r, 5000));
  }

  // 读取意向
  const leads = await api('/api/leads?limit=100');
  console.log(`共 ${leads.count} 条意向`);
})();
```

### Shell 脚本
```bash
#!/bin/bash
BASE="http://127.0.0.1:18911"

# 一键启动
curl -s -X POST "$BASE/api/search/start" \
  -H "Content-Type: application/json" \
  -d '{"keywords":["价格"],"sortEnabled":true,"maxVideos":30}'

# 监控进度
for i in {1..30}; do
  STATE=$(curl -s "$BASE/api/state" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
  echo "[$i] 状态: $STATE"
  [ "$STATE" = "idle" ] && break
  sleep 30
done

# 导出
curl -s "$BASE/api/leads/export" | jq
```

---

## 监控面板（Dashboard）

在浏览器访问 `http://127.0.0.1:18911/api/status` 会返回 JSON。可以包装成简单的 Web 监控页面。

### 简单 Web 监控（保存为 monitor.html）
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>抖音监控状态</title>
  <style>
    body { font-family: monospace; padding: 20px; }
    .card { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 8px; }
    .state { font-size: 24px; font-weight: bold; }
    .state.searching { color: #1976d2; }
    .state.monitoring { color: #388e3c; }
    .state.error { color: #d32f2f; }
    .state.idle { color: #757575; }
    pre { background: #fff; padding: 10px; border-radius: 4px; overflow: auto; }
  </style>
</head>
<body>
  <h1>抖音监控系统状态</h1>
  <div class="card">
    <div>当前状态：<span id="state" class="state">--</span></div>
    <div>阶段：<span id="phase">--</span></div>
    <div>任务：<span id="task">--</span></div>
    <div>最后错误：<span id="error">--</span></div>
    <div>最近更新：<span id="updated">--</span></div>
  </div>
  <div class="card">
    <h3>合法下一步动作</h3>
    <div id="actions">--</div>
  </div>
  <div class="card">
    <h3>原始快照</h3>
    <pre id="raw">--</pre>
  </div>

  <script>
    async function refresh() {
      const r = await fetch('http://127.0.0.1:18911/api/status');
      const data = await r.json();
      const s = data.status;
      document.getElementById('state').textContent = s.current;
      document.getElementById('state').className = 'state ' + s.current;
      document.getElementById('phase').textContent = s.phase;
      document.getElementById('task').textContent = s.taskDesc || '-';
      document.getElementById('error').textContent = s.lastError || '-';
      document.getElementById('updated').textContent = s.updatedAt
        ? new Date(s.updatedAt).toLocaleString() : '-';
      document.getElementById('actions').innerHTML = s.nextActions
        .map(a => `<div>• <b>${a.action}</b> - ${a.description}</div>`).join('');
      document.getElementById('raw').textContent = JSON.stringify(s, null, 2);
    }
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>
```

直接双击打开即可（注意 CORS 与混合内容策略，可能需要简单 HTTP 服务器）。

---

## 性能压测

### 持续运行 7×24 小时
- 内存看门狗：60s 检测一次
- 数据库异步写入：每 5 秒一次
- CDP 缓存 LRU 200 视频
- 历史环形覆盖 1000 条

### 预期资源占用
| 资源 | 空闲 | 搜索中 | 监控中 |
|------|------|--------|--------|
| CPU | < 1% | 5-15% | 3-10% |
| 内存 | 200 MB | 400-700 MB | 300-500 MB |
| 磁盘 IO | 极低 | 中 | 中 |
| 网络 | 0 | 1-5 MB/min | 0.5-2 MB/min |

### 推荐硬件
- 监控 1-5 个博主：8GB RAM + 4 核
- 监控 5-20 个博主：16GB RAM + 8 核
- 监控 20+ 博主：32GB RAM + 16 核（多账号轮换）

---

## 常见自动化场景配置模板

### 模板 1：本地商家线索收集
```json
{
  "search_intent_keywords": [
    "多少钱", "怎么卖", "在哪里买", "价格", "咨询", "代理", "加盟",
    "一件代发", "批发", "货源", "怎么拿货", "联系方式", "微信"
  ],
  "search_garbage_keywords": [
    "666", "好看", "喜欢", "支持", "关注", "已关", "前排", "沙发"
  ],
  "search_interval_minutes": 120,
  "monitor_interval_minutes": 60
}
```

### 模板 2：教育课程线索
```json
{
  "search_intent_keywords": [
    "课程", "学费", "怎么报名", "多少钱", "咨询", "老师", "试听",
    "资料", "学习", "教材"
  ],
  "search_garbage_keywords": [
    "666", "支持", "厉害", "真棒", "前排"
  ],
  "search_interval_minutes": 90
}
```

### 模板 3：医美健康
```json
{
  "search_intent_keywords": [
    "价格", "多少钱", "怎么预约", "咨询", "地址", "医院",
    "医生", "效果", "副作用", "哪里做"
  ],
  "search_interval_minutes": 180
}
```

---

## 调试技巧

### 1. 抓取单条评论数据
```bash
# 启动搜索模式
curl -X POST http://127.0.0.1:18911/api/search/start \
  -d '{"keywords":["价格"], "maxVideos":1}'

# 实时查看评论入库
curl http://127.0.0.1:18911/api/leads
```

### 2. 重现错误
```bash
# 查看最近错误
curl 'http://127.0.0.1:18911/api/errors?limit=10'

# 强制恢复
curl -X POST http://127.0.0.1:18911/api/reset
```

### 3. 性能分析
```bash
# 数据库统计
curl http://127.0.0.1:18911/api/stats
```

### 4. 实时日志
```bash
# Windows
Get-Content logs\2026-01-15.log -Wait

# Linux/macOS
tail -f logs/2026-01-15.log
```
