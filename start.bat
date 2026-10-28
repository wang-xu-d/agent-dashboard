@echo off
rem 一键启动：双击本文件即可。首次运行会自动扫描，然后起服务并打开浏览器。
rem .bat 与 .cmd 在 NT 系 Windows 都由 cmd.exe 执行，行为一致；用 .bat 是双击与工具识别更常见。
rem 可选参数：--no-open / --port 7799 / --full / --help（在 cmd 窗口里：start.bat --port 7799）
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [启动失败] 没有找到 Node.js，请先安装 Node 20 或更新版本：https://nodejs.org/
  pause
  exit /b 1
)

node scripts\start.mjs %*
set "code=%errorlevel%"
if "%code%"=="1" pause
exit /b %code%
