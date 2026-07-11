#!/usr/bin/env bash
# 本地开发/测试用:用 PHP 内置服务器起前端(生产请用 Nginx + php-fpm)
# 与 Windows 版 start-web.bat 行为对齐。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_DIR="$(cd "${SCRIPT_DIR}/../public" && pwd)"

PHP_BIN="${PHP_BIN:-php}"
if ! command -v "${PHP_BIN}" >/dev/null 2>&1; then
    echo "[错误] 未找到 php,请先安装 PHP 8.0+ (apt install php-cli)" >&2
    exit 1
fi

HOST="${WEB_HOST:-127.0.0.1}"
PORT="${WEB_PORT:-8000}"

echo "[启动] PHP 内置服务器 http://${HOST}:${PORT} (docroot=${PUBLIC_DIR})"
cd "${PUBLIC_DIR}"
exec "${PHP_BIN}" -S "${HOST}:${PORT}"
