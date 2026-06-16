# 异常故障排查清单

## 📋 排查流程图

```
应用异常
  │
  ├─ 启动失败？
  │    ├─ Node 未安装 → 安装 Node 18+
  │    ├─ 依赖安装失败 → 切换 npm 镜像
  │    └─ 端口占用 → kill 旧进程
  │
  ├─ 登录失败？
  │    ├─ 验证码 → 手动完成
  │    ├─ 滑块验证 → 手动完成
  │    └─ 账号被风控 → 换号 / 等待
  │
  ├─ 采集无数据？
  │    ├─ CDP 未生效 → 检查登录态
  │    ├─ 评论为 0 → 视频本身无评论
  │    └─ 关键词未匹配 → 检查配置
  │
  ├─ 推送失败？
  │    ├─ SMTP 错误 → 用授权码
  │    ├─ Webhook 失效 → 重新创建
  │    └─ 网络问题 → 检查连接
  │
  └─ 应用崩溃？
       ├─ 内存溢出 → 重启 + GC
       ├─ 渲染进程崩溃 → 重启
       └─ 状态卡死 → /api/reset
```

---

## 🔍 详细排查表

### A. 启动阶段

#### A1. 双击 start.bat 闪退
**排查步骤**：
1. 打开 cmd，手动执行 `node -v` 验证
2. 检查 `logs/` 下当天的启动日志
3. 在项目根目录手动执行 `npm start`，查看完整输出

**常见原因**：
| 原因 | 现象 | 解决 |
|------|------|------|
| Node 版本过低 | `SyntaxError` | 升级到 18+ |
| 依赖缺失 | `Cannot find module` | `npm install` |
| 权限不足 | `EACCES` | 用管理员运行 cmd |
| 端口占用 | `EADDRINUSE` | 杀掉旧进程 |

#### A2. 依赖安装失败
```bash
# 切换国内镜像
npm install --registry=https://registry.npmmirror.com

# 清理缓存
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

#### A3. Electron 启动黑屏
- 检查 `mainWindow` 配置 `webPreferences`
- 确认 `preload.js` 路径正确
- 查看 `logs/` 中 `did-fail-load` 错误

---

### B. 登录阶段

#### B1. 二维码不显示
- 检查网络：抖音可能被墙（需代理）
- 切换全局模式 / 直连
- 重启应用

#### B2. 扫码后"登录失败"
- Cookie 失效 → 清除浏览器数据
- 账号被风控 → 等待 24 小时
- 异地登录 → 短信验证

#### B3. 频繁弹验证码
- 降低采集速度：`config.json` 中 `wait_min/max` 调大
- 增加博主数量：避免单号过载
- 多账号轮换

---

### C. 采集阶段

#### C1. 监控列表为空
- 检查 `config.json` 中 `monitor_bloggers` 数组
- 确认每个博主 `status: 1`（启用）
- 检查 `sec_uid` 是否正确

#### C2. 搜索无结果
- 关键词是否过于冷门
- 时间筛选过窄：放宽到"不限"
- 网络问题：检查是否能打开抖音

#### C3. 评论区打开失败
**现象**：日志显示 "评论区未打开"
- 抖音页面结构变化
- 网络慢导致超时
- 已触发风控

**解决**：
1. 暂停任务，刷新页面
2. 重启应用
3. 等待风控解除

#### C4. CDP 拦截无数据
**排查**：
```bash
# 调用 HTTP API 查看实时错误
curl http://127.0.0.1:18911/api/errors?limit=20
```

**检查点**：
- `cdp_detached`：CDP 调试器断开 → 重新登录
- `json_parse`：响应非 JSON → 抖音风控
- 浏览器 DevTools → Network → 找评论 API 是否带 `data` 字段

#### C5. 进度卡住不动
- 视频加载卡住（网络问题）
- 验证码未处理
- 浏览器无响应

**解决**：
```bash
# 手动恢复
curl -X POST http://127.0.0.1:18911/api/recover

# 强制重置
curl -X POST http://127.0.0.1:18911/api/reset
```

---

### D. 匹配与入库

#### D1. 命中关键词但未入库
- 抖音 ID 重复：`isCommentExists` 跳过
- 屏蔽词命中：被 `garbage_keywords` 过滤
- 评论时间过老：被 `cutoffTs` 过滤

**调整**：
- 减小 `comment_hours`
- 清理 `garbage_keywords`
- 删除 `monitor.db` 重置

#### D2. 评分异常
- 关键词权重配置问题
- 查看 `core/match.js` 评分规则

---

### E. 推送阶段

#### E1. 邮件发送失败
**SMTP 配置示例（QQ邮箱）**：
```json
{
  "email": {
    "enable": true,
    "sender": "your@qq.com",
    "auth_code": "abcdefghijklmnop",  // 16位授权码
    "smtp_host": "smtp.qq.com",
    "smtp_port": 465,
    "secure": true,
    "receivers": ["target@qq.com"]
  }
}
```

**常见错误**：
| 错误 | 原因 | 解决 |
|------|------|------|
| 535 认证失败 | 授权码错误 | 重置授权码 |
| 550 收件人拒绝 | 收件人地址错 | 检查地址 |
| 连接超时 | 端口被封 | 换 25 / 465 / 587 |

#### E2. 企微 Webhook 失败
- Webhook URL 是否完整（带 `?key=xxxx`）
- 群机器人是否被删除
- 是否触发关键字拦截（如 `http://`）

**测试命令**：
```bash
curl 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"msgtype":"text","text":{"content":"测试"}}'
```

---

### F. 应用稳定性

#### F1. 内存持续上涨
**检查**：
```bash
curl http://127.0.0.1:18911/api/stats
```

**优化**：
- 调用 `start-dev.bat`（带 GC）
- 限制 `monitor_bloggers` 数量 ≤ 20
- 减少搜索视频数 `maxVideos`
- 定期重启：cron + `curl -X POST /api/reset`

#### F2. 渲染进程崩溃
- 检查显卡驱动
- 关闭硬件加速：启动参数加 `--disable-gpu`
- 关闭 DevTools

#### F3. 状态机卡死
```bash
# 查看当前状态
cat logs/state.json

# 查看历史
tail -20 logs/state-history.jsonl

# 强制重置
curl -X POST http://127.0.0.1:18911/api/reset

# 或手动
rm logs/state.json
# 重启应用
```

#### F4. 数据库锁死
- 检查是否有其他进程占用 `monitor.db`
- 删除 `monitor.db-shm` `monitor.db-wal`
- 重启应用

---

### G. HTTP API 异常

#### G1. 端口 18911 无法访问
- 确认应用已启动
- 检查防火墙：`netsh advfirewall firewall add rule name="DouyinMonitor" dir=in action=allow protocol=TCP localport=18911`
- 应用日志搜索 "HTTP 控制服务"

#### G2. API 返回 503
- 处理器未注册：检查 `main.js` 的 `setHandlers` 调用
- 模块未加载：先调用对应 IPC 触发懒加载

#### G3. API 返回 500
- 查看 `api/errors` 端点的详细错误
- 查看 `logs/` 当天日志

---

### H. 错误代码速查

| 错误类别 | HTTP 状态 | 含义 |
|----------|-----------|------|
| `auth_required` | 401 | 需重新登录 |
| `captcha` | 429 | 人工验证码 |
| `page_load` | 503 | 页面加载失败 |
| `timeout` | 504 | 操作超时 |
| `network` | 502/503 | 网络异常 |
| `cdp_detached` | 500 | CDP 断开 |
| `data_missing` | 404 | 数据缺失 |
| `element_not_found` | 404 | DOM 选择器失效 |
| `browser_crashed` | 500 | 浏览器崩溃 |
| `json_parse` | 502 | JSON 解析失败 |
| `ipc_failed` | 500 | IPC 通信失败 |
| `unknown` | 500 | 未知错误 |

---

## 🆘 紧急情况

### 完全无法启动
1. 删除 `node_modules`、`package-lock.json`
2. 重新 `npm install`
3. 删除 `monitor.db`（会丢失数据）
4. 重新 `start.bat`

### 数据丢失
- 数据库有自动备份逻辑（`saveToDisk` 原子写入）
- 检查 `monitor.db` 是否被损坏
- 试用 DB Browser for SQLite 打开

### 抖音风控严重
- 立即停止所有任务
- 24-48 小时后再用
- 更换 IP（手机 4G）
- 使用小号

---

## 📞 进一步支持

如按本文档无法解决：
1. 收集 `logs/` 目录当日日志
2. 调用 `/api/stats` `/api/errors` 输出
3. 提供以下信息：
   - 操作系统版本
   - Node 版本
   - 完整错误截图
