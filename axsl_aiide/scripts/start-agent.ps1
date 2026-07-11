$ErrorActionPreference = 'Stop'
Set-Location -Path (Join-Path $PSScriptRoot '..\agent')

if (-not (Test-Path .venv)) {
    Write-Host "[初始化] 创建虚拟环境..."
    python -m venv .venv
    & .\.venv\Scripts\Activate.ps1
    pip install --upgrade pip
    pip install -r requirements.txt
} else {
    & .\.venv\Scripts\Activate.ps1
}

if (-not (Test-Path .env)) {
    Write-Host "[提示] 未找到 agent\.env,已从模板复制,请编辑填入 OPENAI_API_KEY"
    Copy-Item .env.example .env
    notepad .env
}

Write-Host "[启动] Uvicorn on http://127.0.0.1:8100"
python main.py
