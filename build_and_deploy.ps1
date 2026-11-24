# Antigravity UI 汉化一键编译与部署脚本

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RuntimeRunner = Join-Path $ScriptDir 'scripts\run_with_runtime.ps1'

& $RuntimeRunner -Script 'scripts\i18n_core.js'
if ($LASTEXITCODE -ne 0) {
    Write-Host "部署失败，请检查报错输出。" -ForegroundColor Red
    exit $LASTEXITCODE
}

& $RuntimeRunner -Script 'scripts\verify_engine.js'
if ($LASTEXITCODE -ne 0) {
    Write-Host "部署校验失败，请检查 verify_engine.js 输出。" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "部署并校验成功！请按 Ctrl + Q 重启 Antigravity 生效。" -ForegroundColor Green
