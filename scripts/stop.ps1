#requires -version 5.1
<#
  墨灵 MoLing —— 一键停止脚本

  行为：
    1. 按 .run\moling.pid 结束整棵进程树（taskkill /T /F）；
    2. 兜底清扫命令行或可执行路径命中本仓库的 node / moling / cargo 进程；
    3. 释放 1420 端口（仅当占用者同样命中本仓库时才结束，绝不误杀其它程序）；
    4. 删除 pid 文件并汇总结束数量。
#>
$ErrorActionPreference = "Continue"

$root    = Split-Path -Parent $PSScriptRoot
$runDir  = Join-Path $root ".run"
$pidFile = Join-Path $runDir "moling.pid"
$repoPattern = [regex]::Escape($root)

$script:stopped = 0

function Write-Step([string]$text) { Write-Host $text -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host $text -ForegroundColor Green }

function Test-IsOurProcess([string]$cmdLine, [string]$exePath) {
  if (-not [string]::IsNullOrEmpty($cmdLine) -and $cmdLine -match $repoPattern) { return $true }
  if (-not [string]::IsNullOrEmpty($exePath) -and $exePath -match $repoPattern) { return $true }
  return $false
}

function Stop-TreeByPid([int]$targetPid, [string]$reason) {
  if (-not $targetPid) { return }
  if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { return }
  Write-Step ("结束进程 " + $targetPid + "（" + $reason + "）")
  & taskkill /PID $targetPid /T /F 2>$null | Out-Null
  $script:stopped = $script:stopped + 1
}

# ---------- 1. 启动脚本记录的主进程 ----------
if (Test-Path $pidFile) {
  $state = $null
  try { $state = Get-Content $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $state = $null }
  if ($state -and $state.pid) {
    Stop-TreeByPid ([int]$state.pid) "启动脚本记录的主进程"
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# ---------- 2. 兜底清扫本仓库相关进程 ----------
Write-Step "检查残留进程 …"
$candidates = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='moling.exe' OR Name='cargo.exe'" -ErrorAction SilentlyContinue
if ($candidates) {
  foreach ($c in $candidates) {
    if (Test-IsOurProcess $c.CommandLine $c.ExecutablePath) {
      Stop-TreeByPid ([int]$c.ProcessId) ("残留进程：" + $c.Name)
    }
  }
}

# ---------- 3. 释放 1420 端口 ----------
$conns = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  foreach ($conn in $conns) {
    $ownerId = [int]$conn.OwningProcess
    if ($ownerId -le 0) { continue }
    $owner = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ownerId) -ErrorAction SilentlyContinue
    if ($owner -and (Test-IsOurProcess $owner.CommandLine $owner.ExecutablePath)) {
      Stop-TreeByPid $ownerId "占用 1420 端口"
    }
  }
}

# ---------- 4. 收尾核对 ----------
Start-Sleep -Milliseconds 800
$left = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='moling.exe' OR Name='cargo.exe'" -ErrorAction SilentlyContinue |
  Where-Object { Test-IsOurProcess $_.CommandLine $_.ExecutablePath }

Write-Host ""
if ($left) {
  Write-Host "以下进程仍在运行，请手动确认：" -ForegroundColor Yellow
  foreach ($p in $left) {
    Write-Host ("  PID " + $p.ProcessId + "  " + $p.Name)
  }
} else {
  Write-Host "本仓库相关进程已全部结束。" -ForegroundColor Green
}

$portBusy = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
if ($portBusy) {
  Write-Host "端口 1420 仍被占用（可能不是本项目的进程，未强制结束）。" -ForegroundColor Yellow
} else {
  Write-Host "端口 1420 已释放。" -ForegroundColor Green
}

Write-Ok ("完成：本次结束 " + $script:stopped + " 个进程。")
exit 0
