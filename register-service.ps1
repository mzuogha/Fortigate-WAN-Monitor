# Windows Server Service / Task Registration Script
# Run this in PowerShell as Administrator on the target Windows Server

param(
    [string]$Port = "4000"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  FortiGate Dual-WAN Monitor: Windows Server Setup Tool  " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# Check Administrator privileges
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[ERROR] This script must be run as Administrator!" -ForegroundColor Red
    Write-Host "Right-click PowerShell and select 'Run as administrator'." -ForegroundColor Yellow
    Exit 1
}

$appDir = $PSScriptRoot
$serverScript = Join-Path $appDir "server.js"

# 1. Check Node.js
$nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "[!] Node.js was not found in PATH." -ForegroundColor Yellow
    Write-Host "Installing Node.js LTS via winget..." -ForegroundColor Cyan
    try {
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        # Refresh environment PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
    } catch {
        Write-Host "[ERROR] Could not auto-install Node.js. Please download and install from https://nodejs.org" -ForegroundColor Red
        Exit 1
    }
}

$nodePath = (Get-Command "node").Source
Write-Host "[OK] Detected Node.js at: $nodePath" -ForegroundColor Green

# 2. Configure Windows Firewall Inbound Rule for Port 4000
$firewallRuleName = "FortiGate WAN Monitor (Port $Port)"
$existingRule = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue

if (-not $existingRule) {
    Write-Host "Creating Windows Firewall rule for inbound TCP port $Port..." -ForegroundColor Cyan
    New-NetFirewallRule -DisplayName $firewallRuleName `
                        -Direction Inbound `
                        -Action Allow `
                        -Protocol TCP `
                        -LocalPort $Port `
                        -Description "Allows incoming dashboard access and FortiGate webhook events" | Out-Null
    Write-Host "[OK] Firewall rule '$firewallRuleName' created." -ForegroundColor Green
} else {
    Write-Host "[OK] Firewall rule '$firewallRuleName' already exists." -ForegroundColor Green
}

# 3. Create Scheduled Task to run 24/7 on boot
$taskName = "FortiGate-WAN-Monitor"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute $nodePath -Argument "server.js" -WorkingDirectory $appDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                                        -DontStopIfGoingOnBatteries `
                                        -RestartCount 3 `
                                        -RestartInterval (New-TimeSpan -Minutes 1) `
                                        -ExecutionTimeLimit (New-TimeSpan -Days 0) `
                                        -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName `
                       -Action $action `
                       -Trigger $trigger `
                       -Settings $settings `
                       -Principal $principal `
                       -Description "Runs the FortiGate Dual-WAN Link Degradation Monitor as a 24/7 service" | Out-Null

Write-Host "[OK] Windows background task '$taskName' registered to run on boot." -ForegroundColor Green

# 4. Start task immediately
Start-ScheduledTask -TaskName $taskName
Write-Host "[OK] Service started successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Service is running 24/7 in the background." -ForegroundColor Green
Write-Host "Access dashboard at: http://localhost:$Port or http://<server-ip>:$Port" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
