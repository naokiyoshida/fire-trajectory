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

try {
    $output = & $NpmPath run sync 2>&1
    $exitCode = $LASTEXITCODE
    $output | ForEach-Object { Add-Content -Path $LogFile -Value $_ }
    Write-LogLine "npm run sync exited with code $exitCode"
    exit $exitCode
}
catch {
    Write-LogLine "Exception: $_"
    exit 1
}
