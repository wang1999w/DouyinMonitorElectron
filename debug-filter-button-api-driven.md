# Debug: filter-button-api-driven

## 症状（Symptoms）
1. 筛选按钮定位失败，日志显示 `筛选按钮未找到`
2. 暂停期间没有任何模拟操作
3. 进入作品的评论检查流程没有触发

## 实际 vs 预期
- **实际**：`doFilter` 第一步 `_findFilterButton` 返回 `null`，提前 `return`
- **预期**：定位筛选按钮 → hover 打开面板 → 选择排序/时间 → hover+click 关闭

## 调试策略
**操作 API + 网络抓包双驱动**：不再靠 DOM 文本匹配猜测，而是
1. 启动 Electron 应用
2. 用 HTTP API（22 个动作）直接驱动 UI
3. 用 `/api/network/*` 抓包看真实 Douyin 响应
4. 用 `/api/action/dump` 转储 DOM 树查真实结构
5. 用 `/api/action/diagnose` 看页面状态

## 5 个可证伪假设
| # | 假设 | 验证方式 |
|---|------|----------|
| H1 | 应用没有真正启动（HTTP 服务不可达） | `curl /health` |
| H2 | BrowserView 没有加载 douyin.com | `/api/action/diagnose` 看 url |
| H3 | 抖音搜索页"筛选"按钮 DOM 文本/位置不符合预期 | `/api/action/dump` + `/api/action/find text=筛选` |
| H4 | 抖音版本改版，筛选按钮改名为"筛选条件"/icon-only | DOM dump + screenshot |
| H5 | BrowserView 的 `view.webContents` 实际未注入 CDP 抓包 | `/api/network/summary` |

## 进度日志
- [x] 创建调试会话
- [ ] Step 1: 启动 Electron
- [ ] Step 2: 验证 HTTP 服务可达
- [ ] Step 3: 诊断页面状态
- [ ] Step 4: 抓包确认
- [ ] Step 5: 定位根因 + 修复
- [ ] Step 6: 验证
