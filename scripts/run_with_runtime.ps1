param(
  [Parameter(Mandatory = $true)]
  [string]$Script,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ScriptArgs
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$FullScript = if ([System.IO.Path]::IsPathRooted($Script)) { $Script } else { Join-Path $RepoRoot $Script }

if (-not (Test-Path -LiteralPath $FullScript -PathType Leaf)) {
  Write-Host "[错误] 未找到目标脚本: $FullScript" -ForegroundColor Red
  exit 1
}

function Format-WinArg {
  param([string]$Arg)
  if ($null -eq $Arg -or $Arg -eq '') { return '""' }
  if ($Arg -notmatch '[\s"]') { return $Arg }
  $escaped = $Arg -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

function Test-CompatibleNode {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { return $null }
  try {
    $ver = (& $nodeCmd.Source -v 2>$null).Trim()
    if ($ver -match '^v?(\d+)\.(\d+)\.(\d+)') {
      $major = [int]$Matches[1]
      $minor = [int]$Matches[2]
      if ($major -gt 20 -or ($major -eq 20 -and $minor -ge 19)) {
        return $nodeCmd.Source
      }
    }
  } catch {}
  return $null
}

function Find-AntigravityExe {
  $candidates = @()
  if ($env:ANTIGRAVITY_EXE) { $candidates += $env:ANTIGRAVITY_EXE }
  if ($env:ANTIGRAVITY_DIR) { $candidates += (Join-Path $env:ANTIGRAVITY_DIR 'Antigravity.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe') }
  $candidates += (Join-Path $HOME 'AppData\Local\Programs\antigravity\Antigravity.exe')

  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) {
      return $c
    }
  }
  return $null
}

$asarModule = Join-Path $RepoRoot 'node_modules\@electron\asar\package.json'
if (-not (Test-Path -LiteralPath $asarModule -PathType Leaf)) {
  $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
  if ($npmCmd) {
    Write-Host '[提示] 检测到缺少本地依赖，正在执行 npm install --omit=dev...' -ForegroundColor Yellow
    Push-Location $RepoRoot
    try {
      & $npmCmd.Source install --omit=dev
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
      Pop-Location
    }
  } else {
    Write-Host '[错误] 缺少 node_modules/@electron/asar 依赖，且系统未安装 npm。' -ForegroundColor Red
    Write-Host '       请从 GitHub Releases 下载带内置依赖的便携包 (-portable.zip)，或安装 Node.js 22+ 后执行 npm install。' -ForegroundColor Yellow
    exit 1
  }
}

$nodePath = Test-CompatibleNode
if ($nodePath) {
  if ($ScriptArgs -and $ScriptArgs.Count -gt 0) {
    & $nodePath $FullScript @ScriptArgs
  } else {
    & $nodePath $FullScript
  }
  exit $LASTEXITCODE
}

$antigravityExe = Find-AntigravityExe
if (-not $antigravityExe) {
  Write-Host '[错误] 未检测到 Node.js (>= 20.19)，也未找到 Antigravity.exe 内置运行时。' -ForegroundColor Red
  Write-Host '       请先安装 Antigravity 客户端（或设置 ANTIGRAVITY_EXE 环境变量），或安装 Node.js 22+。' -ForegroundColor Yellow
  exit 1
}

$allArgs = @($FullScript)
if ($ScriptArgs -and $ScriptArgs.Count -gt 0) {
  $allArgs += $ScriptArgs
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $antigravityExe
$psi.Arguments = (($allArgs | ForEach-Object { Format-WinArg $_ }) -join ' ')
$psi.WorkingDirectory = $RepoRoot
$psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

$proc = [System.Diagnostics.Process]::Start($psi)
$stdoutTask = $proc.StandardOutput.ReadToEndAsync()
$stderrTask = $proc.StandardError.ReadToEndAsync()
$proc.WaitForExit()
$outText = $stdoutTask.GetAwaiter().GetResult()
$errText = $stderrTask.GetAwaiter().GetResult()

if ($outText) { [Console]::Out.Write($outText) }
if ($errText) { [Console]::Error.Write($errText) }
exit $proc.ExitCode
