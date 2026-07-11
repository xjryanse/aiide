#!/usr/bin/env bash
# axsl-aiide Agent 启动脚本(Linux/macOS)
# 与 Windows 版 start-agent.bat 行为对齐:
#   1) 首次运行创建 venv 并 pip install -r requirements.txt
#   2) 缺 .env 时从 .env.example 复制一份并提示用户编辑
#   3) 启动 uvicorn(通过 python main.py)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/../agent" && pwd)"
cd "${AGENT_DIR}"

# 允许用环境变量指定 python 解释器,默认 python3
PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
    echo "[错误] 未找到 ${PYTHON_BIN},请先安装 Python 3.10+ 并加入 PATH" >&2
    exit 1
fi

if [ ! -d ".venv" ]; then
    echo "[初始化] 创建虚拟环境..."
    "${PYTHON_BIN}" -m venv .venv
    # shellcheck disable=SC1091
    source .venv/bin/activate
    pip install --upgrade pip
    # 优先使用锁版本文件(如果存在),保证跟本地一致
    if [ -f "requirements.lock.txt" ]; then
        echo "[初始化] 使用 requirements.lock.txt 安装依赖..."
        pip install -r requirements.lock.txt
    else
        pip install -r requirements.txt
    fi
else
    # shellcheck disable=SC1091
    source .venv/bin/activate
fi

if [ ! -f ".env" ]; then
    echo "[提示] 未找到 agent/.env,已从模板复制,请编辑填入 OPENAI_API_KEY"
    cp .env.example .env
    echo "[提示] 请编辑: ${AGENT_DIR}/.env"
    # 非交互环境(如 systemd)下不要卡住;交互环境提示一下即可
fi

# HuggingFace 镜像(可选,服务器无外网时把下面这行取消注释或写到 .env)
# export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"

echo "[启动] Uvicorn on http://${AGENT_HOST:-127.0.0.1}:${AGENT_PORT:-8100}"
exec python main.py
