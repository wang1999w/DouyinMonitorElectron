# 部署指南

## 1. 本地 Windows 部署

### 1.1 系统要求
| 项目 | 最低 | 推荐 |
|------|------|------|
| OS | Windows 10 1903+ | Windows 11 |
| CPU | 4 核 | 8 核 |
| 内存 | 8 GB | 16 GB |
| 磁盘 | 2 GB 可用 | 5 GB SSD |
| Node | 18.0 | 20 LTS |

### 1.2 部署步骤

```powershell
# 1. 安装 Node.js（若未安装）
winget install OpenJS.NodeJS.LTS

# 2. 解压项目到任意目录（如 D:\DouyinMonitor）
Expand-Archive DouyinMonitorElectron.zip D:\DouyinMonitor

# 3. 进入目录
cd D:\DouyinMonitor

# 4. 启动
.\start.bat
```

启动脚本会：
- 自动检查 Node/npm
- 首次运行自动 `npm install`
- 创建 `logs/` `exports/` 目录
- 启动应用

### 1.3 配置开机自启
将 `start.bat` 的快捷方式放入：
```
shell:startup
```
或使用 NSSM 注册为 Windows 服务（高级）。

---

## 2. Linux 服务器部署

### 2.1 系统要求
- Ubuntu 20.04+ / CentOS 8+ / Debian 11+
- 2 核 4GB 起步
- Node 18+

### 2.2 部署步骤

```bash
# 1. 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. 安装 Xvfb（虚拟显示）
sudo apt install -y xvfb libnss3 libatk-bridge2.0-0 libxss1 libasound2

# 3. 解压并启动
unzip DouyinMonitorElectron.zip
cd DouyinMonitorElectron
chmod +x start.sh
./start.sh
```

### 2.3 用 xvfb 启动
```bash
# 简单方式
xvfb-run -a ./start.sh

# 或后台运行
xvfb-run -a nohup npm start > logs/xvfb.log 2>&1 &
```

### 2.4 用 systemd 托管
创建 `/etc/systemd/system/douyin-monitor.service`：

```ini
[Unit]
Description=Douyin Monitor
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/DouyinMonitorElectron
Environment=DISPLAY=:99
ExecStart=/usr/bin/xvfb-run -a /usr/bin/npm start
Restart=always
RestartSec=10
StandardOutput=append:/home/ubuntu/DouyinMonitorElectron/logs/service.log
StandardError=append:/home/ubuntu/DouyinMonitorElectron/logs/service.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now douyin-monitor
sudo systemctl status douyin-monitor
```

---

## 3. Docker 部署

### 3.1 Dockerfile
```dockerfile
FROM node:20-slim

# 安装 Xvfb 与 Chromium 依赖
RUN apt-get update && apt-get install -y \
    xvfb libnss3 libatk-bridge2.0-0 libxss1 libasound2 \
    libgbm-dev libxcomposite1 libxdamage1 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制 package 文件优先（缓存优化）
COPY package*.json ./
RUN npm install --omit=dev

# 复制源码
COPY . .

# 创建必要目录
RUN mkdir -p logs exports

# 暴露 HTTP 控制端口
EXPOSE 18911

# 启动命令
CMD ["xvfb-run", "-a", "npm", "start"]
```

### 3.2 docker-compose.yml
```yaml
version: '3.8'
services:
  douyin-monitor:
    build: .
    container_name: douyin-monitor
    restart: unless-stopped
    ports:
      - "18911:18911"
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
      - ./exports:/app/exports
    environment:
      - DISPLAY=:99
      - NODE_ENV=production
```

### 3.3 启动
```bash
docker-compose up -d
docker-compose logs -f
```

### 3.4 访问 HTTP API
```bash
curl http://localhost:18911/health
curl http://localhost:18911/api/status
```

---

## 4. macOS 部署

```bash
# 安装 Node.js
brew install node@20

# 启动
chmod +x start.sh
./start.sh
```

打包成 .app：
```bash
npm install electron-builder --save-dev
npx electron-builder --mac
```

---

## 5. 生产环境检查清单

部署到生产前确认：

- [ ] Node.js ≥ 18 已安装
- [ ] `npm install` 成功完成
- [ ] `logs/` `exports/` 目录可写
- [ ] 磁盘剩余空间 ≥ 5GB
- [ ] 防火墙放行 18911 端口（如需远程）
- [ ] 已登录抖音账号（首次启动需要）
- [ ] 配置好 SMTP / 企微 Webhook
- [ ] 测试邮件 / 企微推送成功
- [ ] 已添加至少 1 个监控博主
- [ ] HTTP API 状态返回 200
- [ ] 状态机可正确读写 `logs/state.json`

---

## 6. 升级步骤

```bash
# 1. 备份数据
cp -r data data.bak.$(date +%Y%m%d)
cp monitor.db monitor.db.bak.$(date +%Y%m%d)

# 2. 停止服务
docker-compose down
# 或
sudo systemctl stop douyin-monitor

# 3. 替换新代码
unzip -o new-version.zip -d /tmp/update
cp -r /tmp/update/* /app/

# 4. 升级依赖
npm install

# 5. 启动
docker-compose up -d
# 或
sudo systemctl start douyin-monitor

# 6. 验证
curl http://127.0.0.1:18911/health
```

---

## 7. 监控与运维

### 7.1 健康检查
```bash
# HTTP 健康
curl -f http://127.0.0.1:18911/health || exit 1

# 状态查询
curl http://127.0.0.1:18911/api/state
```

### 7.2 日志轮转
使用 `logrotate`：

`/etc/logrotate.d/douyin-monitor`：
```
/path/to/DouyinMonitorElectron/logs/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 0640 ubuntu ubuntu
    sharedscripts
    postrotate
        # 通知应用重新打开日志（可选）
    endscript
}
```

### 7.3 数据库备份
```bash
# 每日 03:00 备份
0 3 * * * cp /app/monitor.db /backup/monitor-$(date +\%Y\%m\%d).db
```

### 7.4 告警脚本（示例）
```bash
#!/bin/bash
# 每 5 分钟检查一次状态
STATE=$(curl -s http://127.0.0.1:18911/api/state | jq -r .state)
if [ "$STATE" = "error" ]; then
    echo "抖音监控系统异常！状态: $STATE" | mail -s "告警" admin@example.com
fi
```

```cron
*/5 * * * * /usr/local/bin/check-douyin-monitor.sh
```
