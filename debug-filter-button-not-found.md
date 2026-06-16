# Debug: filter-button-not-found

## 现象（Symptoms）
1. 筛选按钮定位失败，日志显示 `筛选按钮未找到`
2. 暂停期间没有任何模拟操作
3. 进入作品的评论检查流程没有触发

## 实际 vs 预期
- 实际：doFilter 第一步 _findFilterButton 返回 null，提前 return
- 预期：定位到筛选按钮 → hover 打开面板 → 在面板内选择 → hover+click 关闭

## 状态变更
~~[OPEN] 假设已列，证据未收集~~

**切换为：操作 API + 网络抓包调试模式**
（用户要求：给系统功能按钮添加接口 + 抓包工具）

## 新调试策略
不靠 DOM 文本匹配，改为：
1. **直接调用 API 操作** - 通过 HTTP API 驱动筛选按钮
2. **网络抓包分析** - 观察 Douyin 后端实际响应（替代 DOM 猜测）
3. **DOM 结构查询** - 通过 `/api/action/dump` 转储完整 DOM

## 已实现的调试接口
详见 [actionApi.js](../core/actionApi.js) 与 [httpServer.js 路由](../core/httpServer.js)

### HTTP 端点（默认 http://127.0.0.1:18911）
- `GET  /api/action/list` - 列出全部 22 个动作
- `POST /api/action/click` - 点击（text/selector/dataE2E/x,y）
- `POST /api/action/hover` - 悬停（防抖触发面板）
- `POST /api/action/type` - 输入文本
- `POST /api/action/find` - 查找元素
- `POST /api/action/dump` - 转储 DOM 树
- `POST /api/action/diagnose` - 页面诊断
- `POST /api/action/run` - 批量执行序列
- `POST /api/action/screenshot` - 截图
- `GET  /api/network/log` - 抓包日志
- `GET  /api/network/summary` - 最近请求摘要
- `GET  /api/network/search?q=...` - 搜索请求
- `POST /api/network/clear` - 清空日志
- `POST /api/network/export` - 导出 NDJSON

## 待办
- [x] 创建 actionApi.js（22 个动作）
- [x] 扩展 cdpInterceptor.js（全量抓包 + 统计 + 导出）
- [x] httpServer.js 注册所有路由（支持动态 /api/action/{name}）
- [x] main.js 绑定依赖
- [ ] 通过 API 驱动调试实际筛选问题

## 下一步
应用启动后，用以下命令调试：
```bash
# 列出所有动作
curl http://127.0.0.1:18911/api/action/list

# 页面诊断
curl -X POST http://127.0.0.1:18911/api/action/diagnose

# 转储顶部 DOM（找筛选按钮真实结构）
curl -X POST http://127.0.0.1:18911/api/action/dump -H "Content-Type: application/json" -d '{"maxDepth": 4, "maxNodes": 200}'

# 网络抓包最近 50 条
curl "http://127.0.0.1:18911/api/network/recent?n=50"

# 搜索评论接口
curl "http://127.0.0.1:18911/api/network/search?q=comment"
```
