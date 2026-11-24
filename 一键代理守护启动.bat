@echo off
chcp 65001 >nul
pushd "%~dp0"
title Antigravity 汉化自愈与智能代理守护启动
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run_with_runtime.ps1" -Script "scripts\guard_launch.js" %*
if errorlevel 1 (
    echo.
    echo [失败] 代理守护启动出错，请检查上方错误输出！
    popd
    pause
    exit /b 1
)
popd
