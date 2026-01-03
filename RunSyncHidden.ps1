<#
.SYNOPSIS
    Money Forward ME 自動同期起動スクリプト (Headless対応版)

.DESCRIPTION
    Chromeを起動し、Money Forwardの自動同期を開始します。
    
    【重要: ウィンドウが表示されてしまう場合】
    Google Chromeは「同じプロファイルを同時に複数のプロセスで開く」ことができません。
    普段使いのChrome（Profile 1など）が開いている状態でこのスクリプトを実行すると、
    既存のウィンドウに「新しいタブ」として追加されるため、必ず画面が出てしまいます。
    
    【完全非表示(Headless)にする方法】
    1. 同期専用の新しいプロファイル（例: "Profile 99"）を作成し、MFへのログインとTampermonkeyの設定を行ってください。
    2. 下記設定の $ProfileDir をそのプロファイル名に変更してください。
    3. 下記設定の $HeadlessMode を $true に変更してください。
    
    これで、普段のChromeを使っていても、裏側で別プロファイルが完全に隠れて同期してくれます。
#>

# --- 設定項目 ---
$ChromePath_x64 = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ChromePath_x86 = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
$SyncUrl = "https://moneyforward.com/cf?force_auto_sync=true"

# 使用するプロファイル
$ProfileDir = "Profile 1"

# 完全非表示モード (Headless)
# $true にする場合は、普段使っていない（開いていない）プロファイルを指定する必要があります
$HeadlessMode = $false

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
Write-Log "Script started."

$TargetChrome = $null
if (Test-Path $ChromePath_x64) { $TargetChrome = $ChromePath_x64 }
elseif (Test-Path $ChromePath_x86) { $TargetChrome = $ChromePath_x86 }

if (-not $TargetChrome) {
    Write-Log "Fatal: Chrome not found."
    exit 1
}

Write-Log "Target Chrome: $TargetChrome"
Write-Log "Profile: $ProfileDir"
Write-Log "Headless: $HeadlessMode"

try {
    $ArgsList = @(
        "--profile-directory=""$ProfileDir""",
        $SyncUrl
    )
    
    if ($HeadlessMode) {
        # Headlessモード (New)
        # 拡張機能を有効にするために =new が必要
        $ArgsList += "--headless=new"
        $ArgsList += "--disable-gpu"
    }
    
    Start-Process -FilePath $TargetChrome -ArgumentList $ArgsList -WindowStyle Minimized
    Write-Log "Start-Process called."
}
catch {
    Write-Log "Error: $_"
    exit 1
}
