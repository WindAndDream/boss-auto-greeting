@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "config\config.json" (
  echo 请先双击“启动助手.bat”，等待配置生成后再安装插件。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install-astrbot-plugin.ps1"
pause
