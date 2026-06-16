# 抖音评论监控采集系统

> 基于 Electron + Chrome DevTools Protocol 的抖音评论自动化采集工具
> 双栏浏览器面板 + 实时评论拦截 + 自动化测试 + 数据导出

---

## 📋 目录

- [产品特性](#-产品特性)
- [快速开始](#-快速开始)
- [系统架构](#-系统架构)
- [核心模块](#-核心模块)
- [HTTP 控制 API](#-http-控制-api)
- [状态机与故障自愈](#-状态机与故障自愈)
- [使用教程](#-使用教程)
- [异常排查](#-异常排查)
- [常见问题](#-常见问题)
- [开发说明](#-开发说明)

---

## ✨ 产品特性

### 1. 全流程自感知执行状态
- 任何时刻可读取当前真实执行节点（idle / searching / monitoring / paused / error / recovering）
- 状态持久化到 `logs/state.json`，崩溃后可恢复
- 完整历史轨迹（`logs/state-history.jsonl`）

### 2. 分级异常捕获与根因解析
- 自动分类：401 鉴权、页面加载失败、JSON 解析异常、网络中断、数据缺失、CDP 断开等
- 严重度分级：info / warn / error / fatal
- 输出结构化诊断（`[category] 原因 → 建议处理`）

### 3. 故障自愈回退机制
- 致命异常：自动撤销当前操作、清空临时缓存、重置 CDP 拦截
- 按错误类别分发回退策略（`core/recovery.js`）
- 超过频次阈值后强制 IDLE，等待人工介入

### 4. 故障后自动重定位
- 回退到上一个稳定状态
- 自动计算流程中合法的下一步动作
- 持续失败计数，超过上限后放弃自动恢复

### 5. 完整业务功能
| 功能 | 模块 | 状态 |
|------|------|------|
| 双栏 Electron 浏览器面板 | `main/window.js` | ✅ |
| 抖音时效评论流量拦截（CDP） | `core/cdpInterceptor.js` | ✅ |
| 自动化测试一键执行（搜索 + 监控） | `core/search.js` + `core/monitor.js` | ✅ |
| 意向评论匹配 + 评分 | `core/match.js` + `core/pipeline.js` | ✅ |
| 数据导出（Excel + JSON） | `main/ipc.js` `exportToExcelStream` | ✅ |
| 邮件 / 企微推送 | `core/email.js` + `core/wechat.js` | ✅ |
| 本地 HTTP 控制 API（18911） | `core/httpServer.js` | ✅ |
| 内存看门狗 + 状态持久化 | `main/main.js` + `core/stateMachine.js` | ✅ |

---

## 🚀 快速开始

### 环境要求
- **Node.js** ≥ 18.0
- **npm** ≥ 9.0
- **Windows** 10/11、macOS、Linux（推荐 Ubuntu 20.04+）

### 启动步骤

**Windows**：
```bash
# 方式 A：资源管理器双击 start.bat（最简单）
# 方式 B：PowerShell / CMD 命令行
.\start.bat
```

> PowerShell 默认不从当前目录加载命令，必须加 `.\` 前缀。
> 如果双击 start.bat 闪退，请用 CMD 运行 `.\start.bat` 查看错误信息。

**Linux / macOS**：
```bash
chmod +x start.sh
./start.sh
```

启动脚本会：
1. 检查 Node.js 与 npm 版本
2. 自动安装缺失依赖（首次运行）
3. 创建 `logs/` 与 `exports/` 目录
4. 启动 Electron 主进程
5. 启动本地 HTTP 控制服务（`http://127.0.0.1:18911`）

### 调试模式
```bash
# Windows：双击 start-dev.bat，或 PowerShell 输入 .\start-dev.bat
.\start-dev.bat

# 启用 --expose-gc 让内存看门狗可主动触发 GC
```

---

## 🏗 系统架构

```
┌─────────────────────────────────────────────────────┐
│  Renderer（UI）                                     │
│  ├─ 浏览器面板 A（登录、监控）                       │
│  ├─ 浏览器面板 B（搜索采集）                         │
│  └─ 业务面板（搜索/监控/意向/配置/统计）              │
└────────────────────┬────────────────────────────────┘
                     │ IPC（preload 桥接）
┌────────────────────▼────────────────────────────────┐
│  Main Process（主进程）                              │
│  ├─ 状态机（stateMachine.js）持久化                  │
│  ├─ 错误分析器（errorAnalyzer.js）实时分类           │
│  ├─ 恢复管理器（recovery.js）回退 + 重定位           │
│  ├─ HTTP 控制服务（httpServer.js）                   │
│  └─ 调度器 / 搜索 / 监控 / 视频处理 / 数据库          │
└────────────────────┬────────────────────────────────┘
                     │ CDP（Chrome DevTools Protocol）
┌────────────────────▼────────────────────────────────┐
│  Douyin Web（抖音页面）                              │
│  └─ 拦截 /comment/list、/aweme/detail 等 API 响应  │
└─────────────────────────────────────────────────────┘
```

### 目录结构
```
DouyinMonitorElectron/
├── main/                  # 主进程
│   ├── main.js            # 应用入口
│   ├── window.js          # 窗口与 BrowserView
│   ├── ipc.js             # IPC 通信
│   └── webRequest.js      # 网络请求拦截
├── core/                  # 核心业务
│   ├── stateMachine.js    # 状态机
│   ├── errorAnalyzer.js   # 错误分析
│   ├── recovery.js        # 故障恢复
│   ├── httpServer.js      # HTTP 控制服务
│   ├── search.js          # 搜索引擎
│   ├── monitor.js         # 监控引擎
│   ├── videoProcessor.js  # 视频处理
│   ├── pipeline.js        # 匹配流水线
│   ├── match.js           # 关键词匹配
│   ├── cdpInterceptor.js  # CDP 拦截
│   ├── humanBehavior.js   # 拟人行为
│   ├── domUtils.js        # DOM 工具
│   ├── database.js        # SQLite 数据库
│   ├── config.js          # 配置管理
│   ├── email.js           # 邮件发送
│   ├── wechat.js          # 企微推送
│   ├── notifier.js        # 通知聚合
│   ├── scheduler.js       # 任务调度
│   └── logger.js          # 日志
├── renderer/              # 渲染进程（UI）
│   ├── app.js
│   ├── index.html
│   └── panels/            # 业务面板
├── preload/               # 预加载脚本
├── logs/                  # 日志与状态
├── exports/               # 导出文件
├── start.bat              # Windows 启动
├── start.sh               # Linux 启动
├── start-dev.bat          # 调试模式
└── package.json
```

---

## 🔧 核心模块

### 状态机 (`core/stateMachine.js`)
持久化跟踪应用执行节点，提供合法"下一步"自动计算。

```javascript
const { getStateMachine, STATES } = require('./core/stateMachine');
const state = getStateMachine();
state.transition(STATES.SEARCHING, { phase: 'starting' });
state.setPhase('processing_video', { currentAid: '12345' });
state.snapshot(); // 获取完整快照
```

### 错误分析器 (`core/errorAnalyzer.js`)
自动分类所有错误，输出结构化诊断：

```javascript
const { getErrorAnalyzer, CATEGORIES } = require('./core/errorAnalyzer');
const analyzer = getErrorAnalyzer();
const analyzed = analyzer.analyze(new Error('401 Unauthorized'));
// → {
//     category: 'auth_required',
//     severity: 'error',
//     suggestion: '需要重新登录抖音账号',
//     timestamp: '...',
//     context: {},
//     stack: '...'
//   }
```

**支持的错误类别**（共 12 类）：
| 类别 | 触发条件 | 建议处理 |
|------|----------|----------|
| `auth_required` | 401 / token 过期 | 重新登录 |
| `captcha` | 验证码 | 人工完成 |
| `page_load` | 页面加载失败 | 检查 URL/网络 |
| `timeout` | 操作超时 | 重试 |
| `navigation` | 导航拦截 | 检查 URL |
| `json_parse` | JSON 解析失败 | 可能被风控 |
| `network` | DNS / 连接失败 | 检查网络 |
| `cdp_detached` | CDP 调试器断开 | 重新注入 |
| `data_missing` | 数据缺失 | 跳过当前 |
| `element_not_found` | DOM 选择器失效 | 更新选择器 |
| `browser_crashed` | 渲染进程崩溃 | 重启浏览器 |
| `ipc_failed` | IPC 失败 | 检查通信 |

### 故障恢复 (`core/recovery.js`)
按错误类别分发回退动作 + 自动重定位。

### 内存优化
- `cdpInterceptor` LRU 缓存：评论缓存 200 视频，Feed 缓存 500 视频，搜索结果 200 条
- `processedIds` Set 定期清理（5000 上限，淘汰为 2000）
- `main.js` 内存看门狗：60s 检测一次，超过 1.5GB 告警 + GC
- 状态机历史环形 1000 条覆盖

---

## 🌐 HTTP 控制 API

默认监听 `http://127.0.0.1:18911`，仅本地可访问。

### 端点列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（uptime / state / ts） |
| GET | `/api/status` | 完整状态快照（含 phase、task、nextActions） |
| GET | `/api/state` | 仅当前状态 |
| GET | `/api/actions` | 合法下一步动作 |
| POST | `/api/search/start` | 启动搜索（body: 搜索参数） |
| POST | `/api/search/stop` | 停止搜索 |
| POST | `/api/monitor/start` | 启动监控 |
| POST | `/api/monitor/stop` | 停止监控 |
| POST | `/api/reset` | 强制重置为 IDLE |
| POST | `/api/recover` | 手动触发恢复 |
| GET | `/api/config` | 读取配置 |
| POST | `/api/config` | 写入配置（body: `{config: {...}}`） |
| GET | `/api/leads?limit=100&offset=0` | 意向评论分页查询 |
| GET | `/api/leads/export` | 导出意向评论到 `exports/` |
| GET | `/api/stats` | 错误 + 恢复 + 数据库统计 |
| GET | `/api/errors?limit=50` | 错误历史 |
| GET | `/api/logs?lines=200` | 应用日志 |

### 调用示例

```bash
# 查询状态
curl http://127.0.0.1:18911/api/status

# 启动搜索
curl -X POST http://127.0.0.1:18911/api/search/start \
  -H "Content-Type: application/json" \
  -d '{"keywords": ["价格"], "sortEnabled": true, "maxVideos": 20}'

# 停止搜索
curl -X POST http://127.0.0.1:18911/api/search/stop

# 导出意向
curl http://127.0.0.1:18911/api/leads/export

# 读取错误
curl 'http://127.0.0.1:18911/api/errors?limit=20'
```

---

## 🤖 状态机与故障自愈

### 状态转移图
```
       ┌──────┐
       │ idle │ ◄──────────┐
       └──┬───┘            │
          │                │
          ▼                │
   ┌──────────────┐        │
   │  searching   │        │
   │  monitoring  │        │
   └──────┬───────┘        │
          │                │
          ▼                │
       ┌──────┐            │
       │paused│            │
       └──┬───┘            │
          │                │
          ▼                │
   ┌──────────────┐        │
   │   error      │────────┤
   └──────┬───────┘        │
          │                │
          ▼                │
   ┌──────────────┐        │
   │  recovering  │────────┘
   └──────────────┘
```

### 自动恢复策略
- **网络类错误**：等待 2s + 清理当前 CDP 缓存 + 继续当前任务
- **JSON 解析失败**：清理 CDP 缓存 + 跳过当前视频
- **元素未找到**：跳过当前，继续下一个
- **致命错误（浏览器崩溃）**：重置 CDP、等待 5s、回到 IDLE

### 恢复限制
- 同一错误类别 60s 内最多自动恢复 **3 次**
- 连续恢复失败 **10 次** 后强制 IDLE 等待人工
- 恢复间隔 ≥ 3s，避免频繁重试

---

## 📖 使用教程

### 1. 第一次启动
1. 运行 `start.bat` / `start.sh`
2. 左侧浏览器面板打开抖音首页
3. **登录你的抖音账号**（扫码 / 手机号）
4. 登录成功后保持窗口，不要关闭

### 2. 配置监控博主
1. 切换到"监控"标签
2. 点击"添加博主"
3. 方式 A：直接输入抖音号 / 抖音主页链接，自动解析
4. 方式 B：从收藏列表导入
5. 配置关键词（意向词 + 屏蔽词）
6. 启用该博主

### 3. 配置搜索关键词
1. 切换到"搜索"标签
2. 输入关键词列表（多个换行分隔）
3. 选择模式：
   - **时间模式**：按发布时间倒序
   - **数量模式**：按综合排序，可筛选时间
4. 设置评论时效（默认 60 小时）
5. 点击"开始搜索"

### 4. 全局关键词
1. 切换到"配置"标签
2. 配置全局意向词（如：价格、咨询、怎么买、多少钱）
3. 配置全局屏蔽词（如：666、好看、不错）
4. 保存配置

### 5. 启用邮件 / 企微推送
1. 配置标签 → 邮件配置
2. 填写 SMTP 信息（QQ邮箱 / 163 / 自建）
3. 点击"发送测试邮件"验证
4. 同样配置企微 Webhook

### 6. 数据导出
1. 切换到"意向"标签
2. 可按博主/关键词/时间筛选
3. 点击"导出 Excel" → 选择保存路径
4. 导出完成会提示文件位置

### 7. 自动化任务调度
1. 配置标签 → 自动化设置
2. 启用"定时搜索" / "定时监控"
3. 设置时间间隔（推荐 30 分钟）
4. 启用后即使关闭应用，定时器也会触发

### 8. 远程控制（HTTP API）
适用于 Docker / 远程服务器场景。详见上方 [HTTP 控制 API](#-http-控制-api)。

---

## 🚨 异常排查

### 应用启动失败
| 现象 | 原因 | 解决 |
|------|------|------|
| 双击 start.bat 闪退 | Node.js 未安装或版本过低 | 安装 Node 18+ |
| 依赖安装失败 | 网络问题 | `npm install --registry=https://registry.npmmirror.com` |
| 启动后白屏 | 渲染进程崩溃 | 查看 `logs/` 下的当日日志 |
| 端口 18911 占用 | 之前进程未完全退出 | `taskkill /F /IM electron.exe` |

### 采集过程异常
| 现象 | 原因 | 解决 |
|------|------|------|
| 评论数 0 | CDP 未生效 | 重新登录抖音，等待主页加载完成 |
| 频繁验证码 | 抖音风控 | 降低速度，增加停顿；多账号轮换 |
| 401 鉴权失效 | Cookie 过期 | 重新登录 |
| 进度卡住不动 | 视频加载失败 | 检查网络；或调用 `/api/recover` 手动恢复 |
| 内存持续上涨 | 长跑任务 | 调用 `start-dev.bat` 启动 + GC 模式 |

### 推送失败
| 现象 | 原因 | 解决 |
|------|------|------|
| 邮件发不出 | SMTP 错误 | 用"发送测试邮件"验证；QQ邮箱需用授权码 |
| 企微收不到 | Webhook 失效 | 重新创建机器人；检查关键字白名单 |
| 推送重复 | notifier 状态异常 | 重启应用；`curl -X POST /api/reset` |

### 状态机异常
- 查看 `logs/state.json` - 当前快照
- 查看 `logs/state-history.jsonl` - 历史转移
- 调用 `/api/status` - HTTP 实时查询
- 强制重置：`curl -X POST http://127.0.0.1:18911/api/reset`

### 数据库异常
- 数据库文件：`monitor.db`
- 默认 WAL 模式，崩溃后可自动恢复
- 如需重置：删除 `monitor.db`、`monitor.db-shm`、`monitor.db-wal` 三个文件

---

## ❓ 常见问题

**Q: 需要一直开着电脑吗？**
A: 是的，监控/搜索任务依赖本机浏览器。服务器端跑可使用 [HTTP API](#-http-控制-api) 远程控制。

**Q: 一个抖音号能跑多久？**
A: 建议每 4-6 小时休息 1 小时，避免风控。

**Q: 能采集其他平台吗？**
A: 当前只支持抖音。架构支持扩展，需要额外开发 `core/<platform>Interceptor.js`。

**Q: 导出 Excel 失败？**
A: 检查 `exports/` 目录权限；或检查磁盘空间。

**Q: HTTP API 远程能用吗？**
A: 默认仅 `127.0.0.1` 监听。如需远程访问，修改 `main.js` 中 `host: '127.0.0.1'` → `'0.0.0.0'`，并配置防火墙。

**Q: 多久需要重启一次？**
A: 正常 7×24 小时无需重启。内存看门狗会主动 GC；如发现 CPU 持续 100%，手动重启。

**Q: 部署到 Linux 服务器？**
A: 需要 `xvfb` 提供虚拟显示：
```bash
sudo apt install xvfb
xvfb-run -a npm start
```

---

## 🛠 开发说明

### 技术栈
- Electron 28+（主进程 + 渲染进程）
- Chrome DevTools Protocol（CDP）
- sql.js（纯 JS SQLite，无需原生编译）
- exceljs（Excel 导出）
- nodemailer（SMTP 邮件）
- axios（HTTP 客户端）

### 调试技巧
```bash
# 启动 dev 模式（带 GC）
start-dev.bat

# 实时日志
tail -f logs/$(date +%Y-%m-%d).log

# HTTP 健康检查
curl http://127.0.0.1:18911/health

# HTTP 状态查询
curl http://127.0.0.1:18911/api/status

# Chrome DevTools 远程调试
# main.js 中加：--remote-debugging-port=9222
# 然后浏览器访问 chrome://inspect
```

### 扩展开发
新增平台（如快手）：
1. 复制 `core/cdpInterceptor.js` → `core/kuaishouInterceptor.js`
2. 修改 `API_PATTERNS` 常量
3. 在 `main/window.js` 中注册实例
4. 新建 `core/kuaishouSearch.js` / `core/kuaishouMonitor.js`
5. 注册到 `core/httpServer.js` 路由

### 打包发布
```bash
npm install electron-builder --save-dev
npx electron-builder --win --x64
npx electron-builder --mac
npx electron-builder --linux
```

---

## 📜 License

MIT License

## 🙏 致谢

本项目基于 `laizan` 项目的核心选择器与流程启发。核心选择器在 `core/domUtils.js` 中已注明来源。
