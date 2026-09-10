<#
.SYNOPSIS
    Removes FortiGate WAN Monitor: background task, firewall rule, shortcuts and program files.

.DESCRIPTION
    Settings and history (the data folder) are kept unless you add -RemoveData, so a later
    re-install picks up where you left off. Node.js is left installed because other software
    may use it; remove it from Settings > Apps if you no longer need it.

.EXAMPLE
    .\uninstall.ps1
.EXAMPLE
    .\uninstall.ps1 -RemoveData -Silent
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $(if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }) 'FortiGate WAN Monitor'),
    [string]$DataDir = (Join-Path $env:ProgramData 'FortiGate WAN Monitor'),
    [switch]$RemoveData,
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$TaskName = 'FortiGate-WAN-Monitor'
$AppName = 'FortiGate WAN Monitor'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $forward = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))
    foreach ($entry in $PSBoundParameters.GetEnumerator()) {
        if ($entry.Value -is [System.Management.Automation.SwitchParameter]) {
            if ($entry.Value.IsPresent) { $forward += "-$($entry.Key)" }
        } else {
            $forward += "-$($entry.Key)"
            $forward += ('"{0}"' -f ([string]$entry.Value).TrimEnd('\'))
        }
    }
    Write-Host 'Removing the monitor needs administrator rights. Approve the UAC prompt to continue...' -ForegroundColor Cyan
    try {
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $forward -Verb RunAs -PassThru -Wait
        exit $proc.ExitCode
    } catch {
        Write-Host 'Cancelled: administrator permission was not granted.' -ForegroundColor Red
        exit 1223
    }
}

$exitCode = 0
try {
    if (-not $Silent) {
        $what = if ($RemoveData) { 'the monitor AND all its settings and history' } else { 'the monitor (settings and history are kept)' }
        $answer = Read-Host "This will remove $what. Continue? (Y/N)"
        if ($answer -notmatch '^[Yy]') { Write-Host 'Nothing was changed.'; exit 0 }
    }

    Write-Host "Stopping and removing the background task..." -ForegroundColor Cyan
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $serverJs = Join-Path $InstallDir 'server.js'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$serverJs*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    Write-Host "Removing firewall rules and shortcuts..." -ForegroundColor Cyan
    Get-NetFirewallRule -DisplayName 'FortiGate WAN Monitor (Port *)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    $startMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
    Remove-Item (Join-Path $startMenu "$AppName.url"), (Join-Path $startMenu "$AppName Help.url") -Force -ErrorAction SilentlyContinue

    if (Test-Path $serverJs) {
        Write-Host "Removing program files from $InstallDir..." -ForegroundColor Cyan
        Start-Sleep -Seconds 1
        Remove-Item -Path $InstallDir -Recurse -Force
    } elseif (Test-Path $InstallDir) {
        Write-Host "Skipped $InstallDir (it does not look like a $AppName installation)." -ForegroundColor Yellow
    }

    if ($RemoveData -and (Test-Path $DataDir)) {
        Write-Host "Removing settings and history from $DataDir..." -ForegroundColor Cyan
        Remove-Item -Path $DataDir -Recurse -Force
    } elseif (Test-Path $DataDir) {
        Write-Host "Settings and history kept in $DataDir (use -RemoveData to delete them)." -ForegroundColor Gray
    }

    Write-Host "$AppName has been removed. Node.js was left installed." -ForegroundColor Green
} catch {
    $exitCode = 1
    Write-Host "UNINSTALL FAILED: $($_.Exception.Message)" -ForegroundColor Red
}
if (-not $Silent) { Read-Host 'Press Enter to close' | Out-Null }
exit $exitCode
