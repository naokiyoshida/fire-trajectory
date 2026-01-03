<#
.SYNOPSIS
    Money Forward ME 自動同期起動スクリプト (シンプル版 + 最小化付与)

.DESCRIPTION
    Chromeを起動し、Money Forwardの自動同期を開始します。
    タスクスケジューラの「表示しない」と組み合わせて使用しますが、
    Chrome側へも念の為「最小化」を要求します。
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
Write-Log "Script started (Simple + Minimized)."

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
    
    # Start-Process に -WindowStyle Minimized を追加
    # タスクスケジューラがHiddenでも、子プロセス(Chrome)がGUIを持つ場合の保険になります
    Start-Process -FilePath $TargetChrome -ArgumentList $ArgsList -WindowStyle Minimized
    Write-Log "Start-Process called (Minimized)."
}
catch {
    Write-Log "Error: $_"
    exit 1
}
