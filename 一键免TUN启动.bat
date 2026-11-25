@echo off
chcp 65001 >nul
pushd "%~dp0"
title Antigravity 免 TUN 联网启动
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run_with_runtime.ps1" -Script "scripts\guard_launch.js" %*
if errorlevel 1 (
    echo.
    echo [失败] 免 TUN 联网启动出错，请检查上方错误输出！
    popd
    pause
    exit /b 1
)
popd
