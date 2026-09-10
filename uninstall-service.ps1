# FortiGate Dual-WAN Monitor: Service Teardown Script
# Run this in PowerShell as Administrator

$ErrorActionPreference = "SilentlyContinue"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  FortiGate Dual-WAN Monitor: Service Uninstaller       " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

$taskName = "FortiGate-WAN-Monitor"

Write-Host "Stopping task: $taskName..." -ForegroundColor Cyan
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

Write-Host "Unregistering task: $taskName..." -ForegroundColor Cyan
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "Removing firewall rules..." -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName "FortiGate WAN Monitor (Port *)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

Write-Host "[OK] Service successfully removed." -ForegroundColor Green
