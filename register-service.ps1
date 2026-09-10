# Kept for compatibility: the installer is now install.ps1 (or double-click Install.cmd).
# It installs Node.js if needed, installs the app to Program Files and registers the service.
param([int]$Port = 0)
$installer = Join-Path $PSScriptRoot 'install.ps1'
if ($Port -gt 0) { & $installer -Port $Port } else { & $installer }
