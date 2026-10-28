#requires -version 5.1
<#
  墨灵 MoLing —— 一键启动脚本

  用法：
    scripts\start.ps1             开发模式（pnpm tauri dev，热更新，首次需编译 Rust）
    scripts\start.ps1 -Release    启动已打包的 exe（需先执行 pnpm tauri build）

  行为：
    1. 已在运行（.run\moling.pid 存活）则直接提示，不会起第二份；
    2. 后台启动并把输出写入 .run\moling-dev.log / .run\moling-dev.err.log；
    3. 开发模式等待 http://localhost:1420 就绪（最长 300 秒）；
    4. 停止请双击根目录 stop.bat。
#>
[CmdletBinding()]
param([switch]$Release)

$ErrorActionPreference = "Stop"

$root     = Split-Path -Parent $PSScriptRoot
$runDir   = Join-Path $root ".run"
$pidFile  = Join-Path $runDir "moling.pid"
$outLog   = Join-Path $runDir "moling-dev.log"
$errLog   = Join-Path $runDir "moling-dev.err.log"
$readyUrl = "http://localhost:1420"

function Write-Step([string]$text) { Write-Host $text -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host $text -ForegroundColor Green }
function Fail([string]$text) {
  Write-Host ""
  Write-Host $text -ForegroundColor Red
  Write-Host ""
  exit 1
}

if (-not (Test-Path $runDir)) { New-Item -ItemType Directory -Path $runDir | Out-Null }

# ---------- 1. 已在运行则直接返回 ----------
if (Test-Path $pidFile) {
  $state = $null
  try { $state = Get-Content $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $state = $null }
  if ($state -and $state.pid) {
    $running = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    if ($running) {
      Write-Ok ("墨灵已在运行：PID " + $state.pid + "（" + $state.mode + "），启动于 " + $state.startedAt)
      Write-Host "如需重启，请先双击 stop.bat 停止后再启动。"
      exit 0
    }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$mode = "dev"
if ($Release) { $mode = "release" }
$startedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")

# ---------- 2. 启动 ----------
$proc = $null
$logHint = $outLog

if ($Release) {
  Write-Step "正在查找已打包的墨灵 …"
  $relDir = Join-Path $root "src-tauri\target\release"
  $exe = $null
  if (Test-Path $relDir) {
    $exe = Get-ChildItem -Path $relDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -eq ".exe" -and ($_.Name -eq "moling.exe" -or $_.Name -eq "墨灵.exe") } |
      Select-Object -First 1
  }
  if (-not $exe) {
    Fail "未找到打包产物。请先运行：pnpm tauri build --bundles nsis（产物在 src-tauri\target\release\）"
  }
  Write-Step ("启动：" + $exe.FullName)
  $proc = Start-Process -FilePath $exe.FullName -WorkingDirectory $root -PassThru
  if (-not $proc) { Fail "启动失败：无法创建应用进程。" }
  Start-Sleep -Seconds 2
  if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
    Fail "应用启动后立即退出，请检查是否是打包产物损坏或缺少运行库。"
  }
  $logHint = "（打包模式无控制台日志）"
} else {
  foreach ($need in @("cmd", "pnpm", "cargo")) {
    if (-not (Get-Command $need -ErrorAction SilentlyContinue)) {
      Fail ("未找到命令 '" + $need + "'。请确认已安装 Node.js ≥ 20、pnpm、Rust 工具链并加入 PATH。")
    }
  }
  if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Fail "尚未安装前端依赖。请先在项目根目录运行：pnpm install"
  }
  Write-Step "正在后台启动开发实例（pnpm tauri dev）…"
  Set-Content -Path $outLog -Value "" -Encoding UTF8
  Set-Content -Path $errLog -Value "" -Encoding UTF8
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList '/c', 'pnpm tauri dev' -WorkingDirectory $root `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
  if (-not $proc) { Fail "启动失败：无法创建 pnpm tauri dev 进程。" }
}

# 记录 PID（即使后续等待超时也保留，方便 stop.bat 回收）
$stateObj = [pscustomobject]@{ pid = $proc.Id; mode = $mode; startedAt = $startedAt; log = $outLog }
$stateObj | ConvertTo-Json -Compress | Set-Content -Path $pidFile -Encoding ASCII

# ---------- 3. 等待就绪 ----------
$ready = $false

if ($Release) {
  $ready = $true
} else {
  Write-Step "等待应用就绪（首次启动需要编译 Rust，可能 1~5 分钟）…"
  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) { break }
    try {
      $resp = Invoke-WebRequest -Uri $readyUrl -UseBasicParsing -TimeoutSec 2
      if ([int]$resp.StatusCode -ge 200) { $ready = $true; break }
    } catch {
      # 端口尚未监听，继续等待
    }
  }
}

if (-not $ready) {
  $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  Write-Host ""
  if ($alive) {
    Write-Host "已启动，但 300 秒内前端端口未就绪（可能仍在编译）。" -ForegroundColor Yellow
    Write-Host "可以继续等待，或运行 stop.bat 停止后重试。"
  } else {
    Write-Host "启动失败：进程已退出。" -ForegroundColor Red
  }
  Write-Host ("日志：" + $outLog)
  Write-Host ("错误输出：" + $errLog)
  if (Test-Path $outLog) {
    Write-Host ""
    Write-Host "---- 日志末尾 30 行 ----"
    Get-Content $outLog -Tail 30 -Encoding UTF8
  }
  exit 1
}

Write-Host ""
Write-Ok ("墨灵已启动（" + $mode + "）：PID " + $proc.Id)
Write-Host ("日志：" + $logHint)
Write-Host "停止应用：双击 stop.bat（会连同后台进程一起结束）"
if (-not $Release) {
  Write-Host "提示：首次启动会编译 Rust，之后启动通常 10 秒内完成。"
}
exit 0
