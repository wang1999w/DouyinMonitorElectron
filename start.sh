#!/bin/bash
# =====================================================
#  抖音监控采集系统 - 一键启动脚本 (Linux/macOS)
# =====================================================

set -e
cd "$(dirname "$0")/.."

echo ""
echo "============================================================"
echo "  抖音评论监控系统 v1.0 - 一键启动"
echo "============================================================"
echo ""

# 1. 检查 Node.js
echo "[1/5] 检查 Node.js 环境..."
if ! command -v node >/dev/null 2>&1; then
    echo "  X 未检测到 Node.js"
    echo "  请先安装 Node.js 18+ : https://nodejs.org/"
    exit 1
fi
NODE_VER=$(node -v)
echo "  √ Node 版本: $NODE_VER"

# 2. 检查 npm
echo "[2/5] 检查 npm..."
if ! command -v npm >/dev/null 2>&1; then
    echo "  X 未检测到 npm"
    exit 1
fi
NPM_VER=$(npm -v)
echo "  √ npm 版本: $NPM_VER"

# 3. 检查依赖
echo "[3/5] 检查依赖..."
if [ ! -d "node_modules" ]; then
    echo "  ! 首次运行，正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "  X 依赖安装失败"
        echo "  建议：npm install --registry=https://registry.npmmirror.com"
        exit 1
    fi
else
    echo "  √ 依赖已安装"
fi

# 4. 环境自检
echo "[4/5] 环境自检..."
mkdir -p logs exports
echo "  √ 目录就绪"

# 5. 启动应用
echo "[5/5] 启动应用..."
echo ""
echo "============================================================"
echo "  启动中... 首次启动会打开抖音登录页"
echo "  关闭应用请直接关闭窗口，或按 Ctrl+C"
echo "============================================================"
echo ""

# 启动 Electron
npm start
