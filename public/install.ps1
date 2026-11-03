# ==============================================================================
# FlareLens Agent & Mesh Client: Windows 1-Line Installer
# Usage:
#   iwr -useb https://control.flarelens.dev/install.ps1 | iex
#   iwr -useb https://control.flarelens.dev/install.ps1 -OutFile install.ps1; .\install.ps1 -ControlUrl "https://control.flarelens.dev" -EnrollToken "xyz"
# ==============================================================================

param(
    [string]$ControlUrl = "https://control.flarelens.dev",
    [string]$EnrollToken = "",
    [string]$InstallDir = "$env:ProgramFiles\FlareLens",
    [switch]$AsService = $false
)

$ErrorActionPreference = "Stop"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  FlareLens Unified Agent & WireGuard Mesh - Windows Installer  " -ForegroundColor White
Write-Host "================================================================" -ForegroundColor Cyan

# 1. Ensure target directory exists
if (-not (Test-Path $InstallDir)) {
    Write-Host "[*] Creating directory: $InstallDir" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$ExePath = Join-Path $InstallDir "flarelens.exe"
$DownloadUrl = "$ControlUrl/api/v1/agent/binary/windows-amd64"

# 2. Download executable
Write-Host "[*] Downloading FlareLens binary from $DownloadUrl..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ExePath -UseBasicParsing
    Write-Host "[+] Downloaded flarelens.exe successfully" -ForegroundColor Green
} catch {
    Write-Host "[!] Note: Live binary endpoint not available; if running locally, copy flarelens-agent.exe to $ExePath" -ForegroundColor DarkGray
}

# 3. Add to User/System PATH if not present
$CurrentPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::Machine)
if ($CurrentPath -notlike "*$InstallDir*") {
    Write-Host "[*] Adding $InstallDir to System PATH..." -ForegroundColor Yellow
    [Environment]::SetEnvironmentVariable("Path", "$CurrentPath;$InstallDir", [EnvironmentVariableTarget]::Machine)
    Write-Host "[+] PATH updated. You can run 'flarelens' from any terminal." -ForegroundColor Green
}

# 4. Create AppData configuration folder
$ConfigDir = "$env:ProgramData\FlareLens"
if (-not (Test-Path $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}

$ConfigFile = Join-Path $ConfigDir "agent.yaml"
if (-not (Test-Path $ConfigFile)) {
    $ConfigContent = @"
identity:
  node_id: "win-$(hostname)"
  hostname: "$(hostname)"
  provider: "windows"
  region: "local"
  tags:
    - "windows"
    - "client"

control_plane:
  endpoint: "$ControlUrl"
  enroll_token: "$EnrollToken"
  heartbeat_interval: 15s

mesh:
  enabled: true
  interface: "flarelens0"
  port: 51820
  key_path: "$ConfigDir\\mesh.key"
  overlay_ip: "100.64.0.1"
  subnet: "100.64.0.0/10"

telemetry:
  log_level: "info"
"@
    Set-Content -Path $ConfigFile -Value $ConfigContent -Encoding UTF8
    Write-Host "[+] Generated default configuration at $ConfigFile" -ForegroundColor Green
}

# 5. Optional Windows Service Registration
if ($AsService) {
    Write-Host "[*] Registering FlareLens as a background Windows Service..." -ForegroundColor Yellow
    $ServiceName = "FlareLensAgent"
    $BinCommand = "`"$ExePath`" --config `"$ConfigFile`""
    
    # Check if already installed
    $ExistingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($ExistingService) {
        Write-Host "[*] Service already exists. Restarting..." -ForegroundColor Yellow
        Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
        Start-Service -Name $ServiceName
    } else {
        sc.exe create $ServiceName binPath= $BinCommand start= auto DisplayName= "FlareLens Host & Mesh Agent"
        Start-Service -Name $ServiceName
        Write-Host "[+] Windows Service registered and started: $ServiceName" -ForegroundColor Green
    }
}

Write-Host "`n[✓] FlareLens installation complete!" -ForegroundColor Green
Write-Host "----------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "  To run interactively in PowerShell:" -ForegroundColor White
Write-Host "    flarelens --control-url $ControlUrl" -ForegroundColor Cyan
Write-Host "  To connect to the WireGuard mesh overlay:" -ForegroundColor White
Write-Host "    flarelens mesh connect" -ForegroundColor Cyan
Write-Host "----------------------------------------------------------------" -ForegroundColor Cyan
