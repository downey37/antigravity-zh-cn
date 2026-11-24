@echo off
chcp 65001 >nul
pushd "%~dp0"
title Antigravity 汉化自动修复与升级工具
echo ========================================================
echo        Antigravity 界面汉化一键修复 / 升级补丁工具
echo ========================================================
echo.
echo 正在检查运行环境并应用最新汉化补丁，请稍候...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run_with_runtime.ps1" -Script "scripts\patch_antigravity.js"
if errorlevel 1 (
    echo.
    echo [失败] 补丁应用出错，请检查上方错误输出！
    popd
    pause
    exit /b 1
)
echo.
echo 正在运行部署校验...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\run_with_runtime.ps1" -Script "scripts\verify_engine.js"
if errorlevel 1 (
    echo.
    echo [失败] 部署校验未通过，请检查上方输出！
    popd
    pause
    exit /b 1
)
echo.
echo ========================================================
echo 执行并校验通过！若软件正在运行，请按 Ctrl + Q 彻底退出后重新打开。
echo ========================================================
popd
pause
