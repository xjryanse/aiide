#!/usr/bin/env bash
# 停止 axsl-aiide Agent(占用 8100 端口的进程)
# 与 _killports.bat 行为对齐,同时兼顾 web 侧的 8000(php -S)。
set -u

kill_port() {
    local port="$1"
    local pids
    if command -v lsof >/dev/null 2>&1; then
        pids="$(lsof -ti:"${port}" 2>/dev/null || true)"
    elif command -v fuser >/dev/null 2>&1; then
        pids="$(fuser -n tcp "${port}" 2>/dev/null | awk '{$1=$1;print}')"
    else
        # 兜底:ss + grep
        pids="$(ss -ltnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p {print $NF}' \
                | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)"
    fi
    if [ -z "${pids}" ]; then
        echo "端口 ${port} 无进程占用"
        return 0
    fi
    for pid in ${pids}; do
        echo "Killing PID ${pid} (port ${port})"
        kill "${pid}" 2>/dev/null || true
    done
    sleep 1
    for pid in ${pids}; do
        if kill -0 "${pid}" 2>/dev/null; then
            echo "PID ${pid} 未退出,强制 kill -9"
            kill -9 "${pid}" 2>/dev/null || true
        fi
    done
}

kill_port 8100
kill_port 8000
