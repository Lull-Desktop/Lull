# Lull 桌面验收编排：构建原生 host、启动壁纸测试模式、执行层序/命中/动画验收，
# 并在退出后确认桌面已还原。
param(
  [switch]$SkipVerify,
  [int]$HoldSeconds = 0
)

# 原生命令（python/bash/pnpm）经常向 stderr 写正常诊断；Stop 策略会把它变成终止错误。
$ErrorActionPreference = "Continue"
# PowerShell 5.1 默认按 ANSI 读日志；统一 UTF-8，避免中文日志变成乱码。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:PYTHONIOENCODING = "utf-8"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Native = Join-Path $RepoRoot "src-tauri\native"
$Acceptance = Join-Path $RepoRoot "src-tauri\acceptance"
$LogDir = Join-Path $env:TEMP "lull"
$Log = Join-Path $LogDir "test-mode.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "==== Lull 桌面验收 · 一键测试模式 ====" -ForegroundColor Cyan

# 0) 双实例保护
if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "端口 3000 已被占用：可能已有一个 tauri dev 在跑。请先结束它（或跑 check_desktop.py close）再试。" -ForegroundColor Yellow
  exit 1
}

# 1) 找 Python / uv（验收脚本需要 Pillow）
$PY = $null
$PYArgs = @()
$candidates = @()
if ($env:LULL_PYTHON) { $candidates += @{ exe = $env:LULL_PYTHON; args = @() } }
$pythonCmd = (Get-Command python -ErrorAction SilentlyContinue).Source
if ($pythonCmd) { $candidates += @{ exe = $pythonCmd; args = @() } }
$pyLauncher = (Get-Command py -ErrorAction SilentlyContinue).Source
if ($pyLauncher) { $candidates += @{ exe = $pyLauncher; args = @("-3") } }
foreach ($candidate in $candidates) {
  if (-not $candidate.exe -or -not (Test-Path $candidate.exe)) { continue }
  if ($candidate.exe -like "*WindowsApps*") { continue }
  & $candidate.exe @($candidate.args) -c "import PIL" 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $PY = $candidate.exe; $PYArgs = $candidate.args; break }
}
if (-not $PY) {
  $uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
  if ($uv) {
    Write-Host "本地 Python 缺少 Pillow，尝试 uv 临时环境（首次运行会准备依赖）..."
    & $uv run --no-project --with pillow python -c "import PIL" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $PY = $uv
      $PYArgs = @("run", "--no-project", "--with", "pillow", "python")
    }
  }
}
if (-not $PY) {
  Write-Host "找不到带 Pillow 的 Python。" -ForegroundColor Yellow
  Write-Host "  方式一：安装 Python 3.10+ 后执行 `"python -m pip install -r `"$Acceptance\requirements.txt`"`""
  Write-Host "  方式二：安装 uv（https://docs.astral.sh/uv/），脚本会自动使用 uv run --with pillow"
  Write-Host "  方式三：设置 LULL_PYTHON 指向一个已安装 Pillow 的 python.exe"
  exit 1
}
Write-Host "Python runner: $PY $($PYArgs -join ' ')"

# 2) DLL（缺失才构建；需要 Git Bash——系统 PATH 里的 bash 可能是 WSL 的）
if (-not (Test-Path (Join-Path $Native "lull_native.dll"))) {
  Write-Host "构建 native host（lull_native.dll）..."
  $gitBash = $null
  try {
    $execPath = ((& git --exec-path 2>$null) | Out-String).Trim() -replace '\\','/'
    $candidate = ($execPath -replace '/mingw64/libexec/git-core/?$','') + '/bin/bash.exe'
    if (Test-Path $candidate) { $gitBash = $candidate }
  } catch {}
  if (-not $gitBash -and (Test-Path "C:\Program Files\Git\bin\bash.exe")) { $gitBash = "C:\Program Files\Git\bin\bash.exe" }
  if (-not $gitBash) { Write-Host "找不到 Git Bash，无法构建 native host" -ForegroundColor Red; exit 1 }
  & $gitBash (Join-Path $Native "build-shim.sh")
  if ($LASTEXITCODE -ne 0) { Write-Host "native host 构建失败" -ForegroundColor Red; exit 1 }
}

# 3) 启动
Write-Host "启动 pnpm tauri dev（LULL_WALLPAPER=1），日志: $Log"
$env:LULL_WALLPAPER = "1"
$dev = Start-Process -FilePath "pnpm.cmd" -ArgumentList "tauri", "dev" `
  -WorkingDirectory $RepoRoot -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" `
  -NoNewWindow -PassThru

$verifyOk = $true
try {
  # 4) 等待挂载（行首是 "wallpaper-N: attach rc=0"）
  Write-Host "等待壁纸挂载（最多 240 秒）..."
  $mounted = $false
  $deadline = (Get-Date).AddSeconds(240)
  while ((Get-Date) -lt $deadline) {
    if ($dev.HasExited) { break }
    if ((Test-Path $Log) -and (Select-String -Path $Log -Pattern 'attach rc=0' -Quiet)) { $mounted = $true; break }
    Start-Sleep -Milliseconds 800
  }
  if (-not $mounted) {
    Write-Host "未观察到挂载成功。日志尾部：" -ForegroundColor Red
    if (Test-Path $Log) { Get-Content $Log -Tail 25 -Encoding UTF8 }
    exit 1
  }
  Select-String -Path $Log -Pattern '\[wallpaper\]' -Encoding UTF8 | Select-Object -Last 2 | ForEach-Object { Write-Host $_.Line }

  # 5) 自动验收
  if (-not $SkipVerify) {
    & $PY @PYArgs (Join-Path $Acceptance "check_desktop.py") verify --artifacts $LogDir
    $verifyOk = ($LASTEXITCODE -eq 0)
  }

  # 6) 手动测试窗口
  Write-Host ""
  Write-Host "== 测试模式运行中 ==" -ForegroundColor Green
  Write-Host "  Win+D 查看壁纸；右键桌面 / 拖拽 / 任务栏 应全部正常；测完记得回到本窗口。"
  if ($HoldSeconds -gt 0) {
    for ($i = $HoldSeconds; $i -gt 0; $i--) {
      Write-Host -NoNewline "`r$i 秒后自动退出并还原桌面..."
      Start-Sleep -Seconds 1
    }
    Write-Host ""
  } else {
    Read-Host "按回车结束测试并还原桌面" | Out-Null
  }
}
finally {
  # 7) 优雅关闭 + 还原验证
  Write-Host "关闭验收会话..."
  & $PY @PYArgs (Join-Path $Acceptance "check_desktop.py") close

  # WM_CLOSE 之后给应用 8 秒正常退出；超时则强杀 lull（壁纸窗口随进程销毁）。
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Name lull -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 300
  }
  $left = Get-Process -Name lull -ErrorAction SilentlyContinue
  if ($left) {
    Write-Host "应用未自行退出，强制结束 lull 进程..." -ForegroundColor Yellow
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  if (-not $dev.HasExited) {
    if (-not $dev.WaitForExit(5000)) {
      Write-Host "tauri dev 未在 5 秒内退出，强制结束进程树" -ForegroundColor Yellow
      & taskkill /F /T /PID $dev.Id 2>$null | Out-Null
    }
  }
  Start-Sleep -Milliseconds 800
  & $PY @PYArgs (Join-Path $Acceptance "check_desktop.py") wait-restore
  Write-Host "日志/截图目录: $LogDir"
  if (-not $SkipVerify -and -not $verifyOk) {
    Write-Host "注意：验收存在 FAIL 项，详见上方表格。" -ForegroundColor Red
    exit 1
  }
}
