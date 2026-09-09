# FortiGate Dual-WAN Monitor: Service Teardown Script
# Run this in PowerShell as Administrator

$ErrorActionPreference = "SilentlyContinue"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  FortiGate Dual-WAN Monitor: Service Uninstaller       " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

$taskName = "FortiGate-WAN-Monitor"
$firewallRuleName = "FortiGate WAN Monitor (Port 4000)"

Write-Host "Stopping task: $taskName..." -ForegroundColor Cyan
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

Write-Host "Unregistering task: $taskName..." -ForegroundColor Cyan
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "Removing firewall rule: $firewallRuleName..." -ForegroundColor Cyan
Remove-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue

Write-Host "[OK] Service successfully removed." -ForegroundColor Green
