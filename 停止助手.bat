@echo off
chcp 65001 >nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":17861 .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo 助手已停止。
timeout /t 2 >nul
