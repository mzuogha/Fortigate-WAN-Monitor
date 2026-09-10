# Builds fortigate-wan-monitor.zip (next to this folder) for copying to another PC.
# On the target PC: extract the zip and double-click Install.cmd.
# Optional: -IncludeNodeMsi <path> bundles a Node.js installer for PCs without internet access.
param([string]$IncludeNodeMsi = '')

$ErrorActionPreference = 'Stop'
$sourceDir = $PSScriptRoot
$zipPath = Join-Path (Split-Path $sourceDir -Parent) 'fortigate-wan-monitor.zip'

Write-Host "Packaging application into: $zipPath ..." -ForegroundColor Cyan

$filesToInclude = @(
    'Install.cmd', 'Uninstall.cmd', 'install.ps1', 'uninstall.ps1',
    'server.js', 'config.js', 'db.js', 'fortigate-client.js', 'alert-manager.js', 'report-generator.js',
    'smtp-client.js', 'whatsapp-client.js', 'probe-engine.js', 'package.json',
    'start.bat', 'start.ps1', 'register-service.ps1', 'uninstall-service.ps1', 'package-app.ps1',
    'README.md', 'public', 'tests'
)

$staging = Join-Path $env:TEMP 'fg-wan-monitor-staging'
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null

foreach ($item in $filesToInclude) {
    $src = Join-Path $sourceDir $item
    if (Test-Path $src) { Copy-Item -Path $src -Destination (Join-Path $staging $item) -Recurse -Force }
    else { Write-Host "  (missing, skipped) $item" -ForegroundColor Yellow }
}
if ($IncludeNodeMsi) {
    Copy-Item -Path $IncludeNodeMsi -Destination $staging
    Write-Host "  Bundled $(Split-Path $IncludeNodeMsi -Leaf). Install offline with: Install.cmd -NodeMsi .\$(Split-Path $IncludeNodeMsi -Leaf)" -ForegroundColor Gray
}

if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path "$staging\*" -DestinationPath $zipPath -Force
Remove-Item -Recurse -Force $staging

Write-Host "[OK] Package created: $zipPath" -ForegroundColor Green
Write-Host 'Copy it to the target PC, extract it and double-click Install.cmd.' -ForegroundColor Cyan
