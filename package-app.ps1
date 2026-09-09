# Package the application into a clean zip file for migration

$sourceDir = $PSScriptRoot
$zipPath = Join-Path (Split-Path $sourceDir -Parent) "fortigate-wan-monitor.zip"

Write-Host "Packaging application into: $zipPath ..." -ForegroundColor Cyan

$filesToInclude = @(
    "config.js",
    "db.js",
    "fortigate-client.js",
    "smtp-client.js",
    "whatsapp-client.js",
    "probe-engine.js",
    "alert-manager.js",
    "server.js",
    "start.bat",
    "start.ps1",
    "register-service.ps1",
    "uninstall-service.ps1",
    "package-app.ps1",
    "README.md",
    "public"
)

$tempStaging = Join-Path $env:TEMP "fg-wan-monitor-staging"
if (Test-Path $tempStaging) { Remove-Item -Recurse -Force $tempStaging }
New-Item -ItemType Directory -Path $tempStaging | Out-Null

foreach ($item in $filesToInclude) {
    $src = Join-Path $sourceDir $item
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $tempStaging $item) -Recurse -Force
    }
}

if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path "$tempStaging\*" -DestinationPath $zipPath -Force
Remove-Item -Recurse -Force $tempStaging

Write-Host "[OK] Package created successfully at: $zipPath" -ForegroundColor Green
Write-Host "You can now copy this zip file to your Windows Server!" -ForegroundColor Cyan
