<#
.SYNOPSIS
    Money Forward ME 自動同期をバックグラウンド（非表示/最小化）で実行するためのスクリプト
    
.DESCRIPTION
    このスクリプトは、Google Chromeを起動し、Money Forwardの同期用URLを開きます。
    Tampermonkeyスクリプトが自動的に同期を行い、完了後にウィンドウを閉じることを想定しています。
    完全な非表示(-WindowStyle Hidden)はChromeの仕様上機能しない場合があるため、
    「最小化(-WindowStyle Minimized)」での起動を推奨していますが、
    設定によりHiddenを試みることも可能です。

.NOTES
    File Name      : RunSyncHidden.ps1
    Author         : Antigravity
    Prerequisite   : Google Chrome, Fire Trajectory UserScript (v3.61+)
#>

# --- 設定項目 ---
# Chromeのパス (環境に合わせて変更してください)
$ChromePath_x64 = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ChromePath_x86 = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

# 同期用URL (Tampermonkeyが反応するURL)
$SyncUrl = "https://moneyforward.com/cf?force_auto_sync=true"

# ウィンドウの表示モード
# Hidden    : 完全非表示 (タスクバーにも出ない。エラー時に気づきにくいので注意)
# Minimized : 最小化 (タスクバーには出るが画面の邪魔にならない。推奨)
$WindowStyle = "Minimized" 

# ----------------

# Chromeのパスを特定
if (Test-Path $ChromePath_x64) {
    $TargetChrome = $ChromePath_x64
} elseif (Test-Path $ChromePath_x86) {
    $TargetChrome = $ChromePath_x86
} else {
    Write-Error "Chrome executable not found. Please install Chrome or update the path in the script."
    exit 1
}

# プロセス開始
Write-Host "Starting Chrome in $WindowStyle mode..."
Write-Host "URL: $SyncUrl"

try {
    # Start-Processを使ってウィンドウスタイルを指定して起動
    Start-Process -FilePath $TargetChrome -ArgumentList $SyncUrl -WindowStyle $WindowStyle
    
    Write-Host "Chrome started successfully. The sync script should close the window automatically when done."
} catch {
    Write-Error "Failed to start Chrome: $_"
    exit 1
}
