@echo off
for /f "tokens=5" %%i in ('netstat -aon ^| findstr :8100 ^| findstr LISTENING') do (
    echo Killing PID %%i
    taskkill /pid %%i /T /F
)
for /f "tokens=5" %%i in ('netstat -aon ^| findstr :8000 ^| findstr LISTENING') do (
    echo Killing PID %%i
    taskkill /pid %%i /T /F
)
