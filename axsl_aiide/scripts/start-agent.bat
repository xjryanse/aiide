@echo off
setlocal
cd /d "%~dp0..\agent"

if not exist ".venv\" (
    echo [初始化] 创建虚拟环境...
    python -m venv .venv
    if errorlevel 1 (
        echo [错误] 未找到 python,请先安装 Python 3.10+ 并加入 PATH
        exit /b 1
    )
    call .venv\Scripts\activate.bat
    pip install --upgrade pip
    pip install -r requirements.txt
) else (
    call .venv\Scripts\activate.bat
)

if not exist ".env" (
    echo [提示] 未找到 agent\.env,已复制模板,请编辑填入 OPENAI_API_KEY
    copy .env.example .env
    notepad .env
)

echo [启动] Uvicorn on http://127.0.0.1:8100
python main.py
