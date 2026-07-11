@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

set "ROOT=%CD%"
set "AGENT_DIR=%ROOT%\agent"
set "PUBLIC_DIR=%ROOT%\public"

echo ========================================
echo   axsl-aiide 一键启动(Web 版)
echo ========================================
echo   ROOT       = %ROOT%
echo   AGENT_DIR  = %AGENT_DIR%
echo   PUBLIC_DIR = %PUBLIC_DIR%
echo.

REM ---- 1. 检查 Python venv ----
if not exist "%AGENT_DIR%\.venv\Scripts\python.exe" (
    echo [初始化] 尚未安装 Python 依赖,先运行 start-agent.bat 完成初始化
    call "%~dp0start-agent.bat"
    exit /b
)

REM ---- 2. 检查 .env 里 OPENAI_API_KEY ----
if not exist "%AGENT_DIR%\.env" (
    echo [错误] 未找到 %AGENT_DIR%\.env,请先运行 start-agent.bat 生成
    pause
    exit /b 1
)
findstr /R /C:"^OPENAI_API_KEY=sk-xxxxx" "%AGENT_DIR%\.env" >nul
if not errorlevel 1 (
    echo.
    echo [警告] OPENAI_API_KEY 还是占位符,现在打开 .env 让你填
    echo         填完保存关闭记事本后本脚本会继续
    echo.
    notepad "%AGENT_DIR%\.env"
)

REM ---- 3. 定位 PHP ----
set "PHP_EXE="
for %%P in ("d:\phpstudy_pro\Extensions\php\php8.0.2nts\php.exe" "d:\phpstudy_pro\Extensions\php\php7.3.4nts\php.exe") do (
    if exist %%P if not defined PHP_EXE set "PHP_EXE=%%~P"
)
if not defined PHP_EXE (
    where php >nul 2>nul && for /f "delims=" %%A in ('where php') do if not defined PHP_EXE set "PHP_EXE=%%A"
)
if not defined PHP_EXE (
    echo [错误] 未找到 PHP,请手动设置 PHP_EXE 环境变量
    pause
    exit /b 1
)
echo [PHP ] %PHP_EXE%

REM ---- 4. 启动 Python 后端到新窗口 ----
echo.
echo [启动] Python Agent  (http://127.0.0.1:8100)
start "axsl-aiide agent" cmd /k "cd /d %AGENT_DIR% && set PYTHONIOENCODING=utf-8 && .venv\Scripts\python.exe main.py"

REM 稍等后端就绪
timeout /t 3 /nobreak >nul

REM ---- 5. 启动 PHP 内置 web server 到新窗口 ----
REM   ⚠ PHP 内置 server 默认单进程,SSE 长连接会独占唯一 worker,
REM     导致多 tab 并发对话被串行阻塞。用 PHP_CLI_SERVER_WORKERS 开多个 worker。
echo [启动] PHP  Web UI  (http://127.0.0.1:8000, workers=8)
start "axsl-aiide web" cmd /k "cd /d %PUBLIC_DIR% && set PHP_CLI_SERVER_WORKERS=8&& "%PHP_EXE%" -S 127.0.0.1:8000 -t ."

REM ---- 6. 自动打开浏览器 ----
timeout /t 2 /nobreak >nul
echo.
echo [完成] 打开浏览器访问:
echo         http://127.0.0.1:8000
echo.
echo 关闭时请手动关闭上面两个弹出的 cmd 窗口
start "" "http://127.0.0.1:8000"

endlocal
