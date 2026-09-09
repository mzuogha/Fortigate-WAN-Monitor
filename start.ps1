# FortiGate Dual-WAN Link Monitor & Failover Guard
# PowerShell Startup Script

Set-Location $PSScriptRoot

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  FortiGate Dual-WAN Link Monitor & Failover Guard      " -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

$agyNode = Get-Command "agy-node.cmd" -ErrorAction SilentlyContinue
$systemNode = Get-Command "node" -ErrorAction SilentlyContinue

if ($agyNode) {
    Write-Host "[OK] Using Antigravity Node runtime ($($agyNode.Source))" -ForegroundColor Green
    & agy-node.cmd server.js
} elseif ($systemNode) {
    Write-Host "[OK] Using system Node.js ($($systemNode.Source))" -ForegroundColor Green
    & node server.js
} elseif (Test-Path "$env:APPDATA\Antigravity\agy-node.cmd") {
    Write-Host "[OK] Using Antigravity Node runtime from AppData" -ForegroundColor Green
    & "$env:APPDATA\Antigravity\agy-node.cmd" server.js
} else {
    Write-Host "[ERROR] Node.js or agy-node.cmd was not found." -ForegroundColor Red
    Write-Host "Install Node.js via: winget install OpenJS.NodeJS" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
}
