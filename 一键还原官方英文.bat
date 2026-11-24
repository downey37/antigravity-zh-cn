@echo off
chcp 65001 >nul
pushd "%~dp0"
title Antigravity 一键还原官方英文原版
echo ========================================================
echo        Antigravity 一键还原官方英文原版工具
echo ========================================================
echo.
echo 正在恢复官方原始程序包，请稍候...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run_with_runtime.ps1" -Script "scripts\restore_antigravity.js"
if errorlevel 1 (
    echo.
    echo [失败] 还原出错，请检查上方输出（如提示文件被占用，请按 Ctrl + Q 彻底退出 Antigravity 后重试）。
    popd
    pause
    exit /b 1
)
echo.
echo ========================================================
echo 还原完成！请按 Ctrl + Q 彻底退出并重新打开 Antigravity 生效。
echo ========================================================
popd
pause
