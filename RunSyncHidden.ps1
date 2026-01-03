<#
.SYNOPSIS
    Money Forward ME 自動同期起動スクリプト (Headless対応版)

.DESCRIPTION
    Chromeを起動し、Money Forwardの自動同期を開始します。
    実行結果は 'run_log.txt' に出力されます（前回分のログは上書きされます）。
#>

# --- 設定項目 ---
$ChromePath_x64 = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ChromePath_x86 = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
$SyncUrl = "https://moneyforward.com/cf?force_auto_sync=true"

# 使用するプロファイル
$ProfileDir = "Profile 1"

# 完全非表示モード (Headless)
$HeadlessMode = $false

# ログファイルパス
$LogFile = Join-Path $PSScriptRoot "run_log.txt"

# ログ初期化 (前回のログを削除してリセット)
# これによりファイルサイズが無限に増えるのを防ぎます
if (Test-Path $LogFile) { Remove-Item $LogFile -Force }

function Write-Log {
    param($Message)
    $Date = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $LogMessage = "[$Date] $Message"
    Add-Content -Path $LogFile -Value $LogMessage
    Write-Host $LogMessage
}

Write-Log "----------------------------------------"
Write-Log "Script started."

$TargetChrome = $null
if (Test-Path $ChromePath_x64) { $TargetChrome = $ChromePath_x64 }
elseif (Test-Path $ChromePath_x86) { $TargetChrome = $ChromePath_x86 }

if (-not $TargetChrome) {
    Write-Log "Fatal: Chrome not found."
    exit 1
}

Write-Log "Target Chrome: $TargetChrome"
# Profile情報は重要なデバッグ情報なので残します
Write-Log "Profile: $ProfileDir"
Write-Log "Headless: $HeadlessMode"

try {
    $ArgsList = @(
        "--profile-directory=""$ProfileDir""",
        $SyncUrl
    )
    
    if ($HeadlessMode) {
        $ArgsList += "--headless=new"
        $ArgsList += "--disable-gpu"
    }
    
    # -WindowStyle Minimized: タスクスケジューラ以外から実行した際の保険
    Start-Process -FilePath $TargetChrome -ArgumentList $ArgsList -WindowStyle Minimized
    Write-Log "Start-Process called."
}
catch {
    Write-Log "Error: $_"
    exit 1
}
