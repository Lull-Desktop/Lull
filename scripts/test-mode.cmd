@echo off
rem Lull 桌面验收入口：转发参数到 PowerShell 编排脚本。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0test-mode.ps1" %*
if "%~1"=="" pause
