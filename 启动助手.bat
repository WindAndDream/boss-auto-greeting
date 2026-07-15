@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%USERPROFILE%\.astrbot_launcher\components\nodejs\node.exe"
if not exist "%NODE%" (
  echo 未找到 Node.js，请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)
start "BOSS QQ Assistant" /min "%NODE%" "bridge\server.mjs"
echo 助手已启动：http://127.0.0.1:17861/health
pause
