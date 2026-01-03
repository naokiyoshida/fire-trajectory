<#
.SYNOPSIS
    Money Forward ME 自動同期起動スクリプト (シンプル版)

.DESCRIPTION
    Chromeを起動し、Money Forwardの自動同期を開始します。
    ウィンドウの制御はタスクスケジューラ側の設定（「表示しない/Hidden」）に委ねることを推奨します。
#>

# --- 設定項目 ---
$ChromePath_x64 = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ChromePath_x86 = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
$SyncUrl = "https://moneyforward.com/cf?force_auto_sync=true"
$ProfileDir = "Profile 1"

# ログファイルパス
$LogFile = Join-Path $PSScriptRoot "run_log.txt"

function Write-Log {
    param($Message)
    $Date = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $LogMessage = "[$Date] $Message"
    Add-Content -Path $LogFile -Value $LogMessage
    Write-Host $LogMessage
}

Write-Log "----------------------------------------"
Write-Log "Script started (Simple Launcher)."

$TargetChrome = $null
if (Test-Path $ChromePath_x64) { $TargetChrome = $ChromePath_x64 }
elseif (Test-Path $ChromePath_x86) { $TargetChrome = $ChromePath_x86 }

if (-not $TargetChrome) {
    Write-Log "Fatal: Chrome not found."
    exit 1
}

Write-Log "Target Chrome: $TargetChrome"

try {
    $ArgsList = @(
        "--profile-directory=""$ProfileDir""",
        $SyncUrl
    )
    
    # 既存のChromeプロセスがある場合、新しいタブとして追加されることが多い
    # タスクスケジューラの「表示しない」で起動されればウィンドウは出ないはず
    Start-Process -FilePath $TargetChrome -ArgumentList $ArgsList
    Write-Log "Start-Process called."
}
catch {
    Write-Log "Error: $_"
    exit 1
}
