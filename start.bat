@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没找到 Node.js。请先到 https://nodejs.org 下载安装 LTS 版（18 以上），装好后再双击这个文件。
  pause
  exit /b 1
)
node bin\companion-memory.mjs start %*
pause
