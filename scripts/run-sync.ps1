<#
.SYNOPSIS
    Monthly sync launcher for fire-trajectory.

.DESCRIPTION
    Designed to be invoked by Windows Task Scheduler.
    Moves into the project directory, runs `npm run sync`,
    and appends output to logs\sync-YYYY-MM-DD.log.

.NOTES
    Task Scheduler example:
      Program: powershell.exe
      Arguments: -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\Workspaces\fire-trajectory\scripts\run-sync.ps1"
      Trigger: monthly (e.g. 1st of every month at 09:00)
      Settings: "Run only when user is logged on" + "Hidden" recommended
#>

$ErrorActionPreference = "Continue"

# Project root (parent of this script directory)
$ProjectDir = Split-Path -Parent $PSScriptRoot

$LogsDir = Join-Path $ProjectDir "logs"
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}

$DateStr = Get-Date -Format "yyyy-MM-dd"
$LogFile = Join-Path $LogsDir "sync-$DateStr.log"

function Write-LogLine {
    param([string]$Message)
    $Ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "[$Ts] $Message"
}

Write-LogLine "----------------------------------------"
Write-LogLine "run-sync.ps1 starting (project=$ProjectDir)"

# Locate npm (PATH may differ under Task Scheduler)
$NpmCandidates = @(
    "C:\Program Files\nodejs\npm.cmd",
    "C:\Program Files (x86)\nodejs\npm.cmd"
)
$NpmPath = $null
foreach ($p in $NpmCandidates) {
    if (Test-Path $p) { $NpmPath = $p; break }
}

if (-not $NpmPath) {
    Write-LogLine "Fatal: npm.cmd not found in standard locations"
    exit 1
}
Write-LogLine "Using npm: $NpmPath"

Set-Location $ProjectDir

$SessionFlag = Join-Path $LogsDir "SESSION_EXPIRED.txt"
$sessionExpired = $false

try {
    # 1) セッション事前チェック。失効していると無人実行は何も取得できずに
    #    「正常終了」してしまうため、ここで早期に検知して可視化する。
    $csOut = & $NpmPath run -s check-session 2>&1
    $csCode = $LASTEXITCODE
    $csOut | ForEach-Object { Add-Content -Path $LogFile -Value $_ }
    Write-LogLine "check-session exited with code $csCode"

    if ($csCode -eq 2) {
        $sessionExpired = $true
        $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Set-Content -Path $SessionFlag -Value "[$ts] セッション失効。手動で 'npm run login' を実行してください。"
        Write-LogLine "SESSION EXPIRED: 手動で 'npm run login' が必要。フラグ: $SessionFlag"
        # プロジェクトの通知経路でメール（未設定ならログのみ）。失敗しても続行。
        try {
            & $NpmPath run -s dev -- notify "セッション失効: 月次同期が実行できません" "run-sync.ps1: check-session が失効を検知。$ProjectDir で 'npm run login' を実行してください。" 2>&1 |
                ForEach-Object { Add-Content -Path $LogFile -Value $_ }
        } catch {
            Write-LogLine "notify 呼び出しに失敗: $_"
        }
    }
    elseif (Test-Path $SessionFlag) {
        # セッションが回復したら古いフラグを掃除
        Remove-Item $SessionFlag -Force -ErrorAction SilentlyContinue
        Write-LogLine "セッション回復: 旧 SESSION_EXPIRED フラグを削除"
    }

    # 2) 本同期。セッション失効時も実行する（各 pipeline の通知経路にも乗せるため）。
    $output = & $NpmPath run sync 2>&1
    $exitCode = $LASTEXITCODE
    $output | ForEach-Object { Add-Content -Path $LogFile -Value $_ }
    Write-LogLine "npm run sync exited with code $exitCode"

    # セッション失効時は Task Scheduler の「前回の実行結果」で失敗が見えるよう非0で終了
    if ($sessionExpired) { exit 2 }
    exit $exitCode
}
catch {
    Write-LogLine "Exception: $_"
    exit 1
}
