<#
.SYNOPSIS
    Installs (or upgrades) FortiGate WAN Monitor as a 24/7 background service on Windows.

.DESCRIPTION
    - Asks for administrator rights once (Windows UAC prompt) and re-launches itself elevated.
    - Downloads and silently installs Node.js LTS from nodejs.org if it is missing or too old
      (SHA-256 checksum and digital signature verified). Falls back to winget if needed.
    - Optionally downloads the application itself from GitHub (-FromGitHub).
    - Installs the app to Program Files and its data to a locked-down ProgramData folder.
    - Registers a startup task running as SYSTEM that restarts automatically, opens the
      Windows Firewall port, adds Start-menu shortcuts and verifies the service is listening.
    - Re-running it upgrades in place and keeps all settings and history.

.EXAMPLE
    .\install.ps1
    Interactive install from the extracted folder (double-clicking Install.cmd does the same).

.EXAMPLE
    .\install.ps1 -Port 5000 -PromptForPassword
    Install on port 5000 and set the dashboard password during installation.

.EXAMPLE
    .\install.ps1 -FromGitHub -Silent
    Unattended install of the latest code from GitHub (for RMM / Intune / GPO running as SYSTEM).
#>
[CmdletBinding()]
param(
    # Where the application code is installed (admin-only folder).
    [string]$InstallDir = (Join-Path $(if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }) 'FortiGate WAN Monitor'),
    # Where the database, logs and install log are kept (restricted to Administrators and SYSTEM).
    [string]$DataDir = (Join-Path $env:ProgramData 'FortiGate WAN Monitor'),
    # Listening port. 0 = keep the current setting (4000 on a new install).
    [int]$Port = 0,
    # Download the application from GitHub instead of using the folder this script is in.
    [switch]$FromGitHub,
    [string]$Repository = 'mzuogha/Fortigate-WAN-Monitor',
    [string]$Branch = 'main',
    # Pin a Node.js version (e.g. 24.11.1). Default: newest LTS release that meets the minimum.
    [string]$NodeVersion = '',
    # Use a pre-downloaded Node.js MSI instead of downloading one (offline installs).
    [string]$NodeMsi = '',
    # HTTP proxy for downloads, e.g. http://proxy.company.local:8080 (uses your Windows credentials).
    [string]$Proxy = '',
    # Ask for a dashboard password during installation (enables remote dashboard access).
    [switch]$PromptForPassword,
    # Dashboard password for unattended installs that already run elevated (e.g. as SYSTEM).
    [Security.SecureString]$DashboardPassword,
    # Which remote addresses may reach the dashboard/webhook port (e.g. LocalSubnet, 192.168.1.0/24).
    [string]$FirewallRemoteAddress = 'Any',
    [switch]$NoFirewall,
    [switch]$NoStart,
    # No prompts and no "press Enter" at the end.
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar in PS 5.1
$TaskName = 'FortiGate-WAN-Monitor'
$AppName = 'FortiGate WAN Monitor'
$MinNode = [version]'22.13.0'

# ------------------------------------------------------------------------------------------
# 1. Elevate (one UAC prompt) and make sure we run as 64-bit PowerShell
# ------------------------------------------------------------------------------------------
function Test-IsAdmin {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$needs64 = [Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess
if (-not (Test-IsAdmin) -or $needs64) {
    if (-not $PSCommandPath) {
        Write-Host 'Please save install.ps1 to a file and run it from there.' -ForegroundColor Red
        exit 1
    }
    $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $sysnative = Join-Path $env:WINDIR 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
    if ($needs64 -and (Test-Path $sysnative)) { $psExe = $sysnative }

    $forward = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))
    $askPassword = $false
    foreach ($entry in $PSBoundParameters.GetEnumerator()) {
        $value = $entry.Value
        if ($value -is [System.Management.Automation.SwitchParameter]) {
            if ($value.IsPresent) { $forward += "-$($entry.Key)" }
        } elseif ($value -is [Security.SecureString]) {
            $askPassword = $true   # secure strings cannot cross the elevation boundary; ask again
        } else {
            $forward += "-$($entry.Key)"
            $forward += ('"{0}"' -f ([string]$value).TrimEnd('\'))
        }
    }
    if ($askPassword -and -not $PromptForPassword) { $forward += '-PromptForPassword' }

    if (-not (Test-IsAdmin)) {
        Write-Host "$AppName setup needs administrator rights." -ForegroundColor Cyan
        Write-Host 'Approve the Windows UAC prompt to continue...' -ForegroundColor Cyan
    }
    try {
        $proc = Start-Process -FilePath $psExe -ArgumentList $forward -Verb RunAs -PassThru -Wait
        exit $proc.ExitCode
    } catch {
        Write-Host 'Setup cancelled: administrator permission was not granted.' -ForegroundColor Red
        exit 1223
    }
}

# ------------------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------------------
$script:StepNo = 0
function Write-Step([string]$Text) {
    $script:StepNo++
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $script:StepNo, $Text) -ForegroundColor Cyan
}
function Write-Ok([string]$Text) { Write-Host "    OK  $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "    ..  $Text" -ForegroundColor Gray }
function Write-Warn([string]$Text) { Write-Host "    !!  $Text" -ForegroundColor Yellow }

function Get-ProgramFilesDir {
    if ($env:ProgramW6432) { return $env:ProgramW6432 }
    return $env:ProgramFiles
}

function Invoke-Download {
    param([string]$Uri, [string]$OutFile = '')
    $params = @{ Uri = $Uri; UseBasicParsing = $true; TimeoutSec = 600 }
    if ($OutFile) { $params.OutFile = $OutFile }
    if ($Proxy) { $params.Proxy = $Proxy; $params.ProxyUseDefaultCredentials = $true }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $response = Invoke-WebRequest @params
            if ($OutFile) { return $null }
            $content = $response.Content
            if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
            return $content
        } catch {
            if ($attempt -eq 3) { throw "Download failed: $Uri ($($_.Exception.Message))" }
            Write-Note "Download attempt $attempt failed, retrying..."
            Start-Sleep -Seconds (5 * $attempt)
        }
    }
}

function Get-NodeVersion([string]$Exe) {
    if (-not $Exe -or -not (Test-Path $Exe)) { return $null }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe --version 2>$null
        if ("$out" -match 'v(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
    } catch { } finally { $ErrorActionPreference = $previous }
    return $null
}

function Invoke-App([string[]]$Arguments) {
    # Node may print warnings on stderr; Windows PowerShell 5.1 would treat those as fatal.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $env:NODE_NO_WARNINGS = '1'
    try {
        $output = & $script:NodeExe (Join-Path $InstallDir 'server.js') @Arguments 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw "Command 'server.js $($Arguments -join ' ')' failed: $($output -join ' ')" }
    return ($output -join "`n").Trim()
}

function Test-PortListening([int]$PortNumber) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne(1000) -and $client.Connected) { return $true }
        return $false
    } catch { return $false } finally { $client.Close() }
}

function Install-NodeJs {
    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }
    $msiPath = $null
    $expectedHash = $null

    if ($NodeMsi) {
        $msiPath = (Resolve-Path $NodeMsi).Path
        Write-Note "Using provided installer: $msiPath"
    } else {
        Write-Note 'Looking up the current Node.js LTS release on nodejs.org...'
        $releases = (Invoke-Download 'https://nodejs.org/dist/index.json') | ConvertFrom-Json
        if ($NodeVersion) {
            $wanted = 'v' + $NodeVersion.TrimStart('v')
            $release = $releases | Where-Object { $_.version -eq $wanted } | Select-Object -First 1
            if (-not $release) { throw "Node.js version $wanted was not found on nodejs.org." }
        } else {
            $release = $releases | Where-Object {
                $_.lts -and ([version]$_.version.TrimStart('v')) -ge $MinNode -and ($_.files -contains "win-$arch-msi")
            } | Select-Object -First 1
            if (-not $release) { throw "No Node.js LTS release for win-$arch was found." }
        }
        $version = $release.version
        $fileName = "node-$version-$arch.msi"
        $baseUrl = "https://nodejs.org/dist/$version"
        $msiPath = Join-Path $env:TEMP $fileName
        Write-Note "Downloading Node.js $version ($arch)..."
        Invoke-Download "$baseUrl/$fileName" $msiPath | Out-Null

        $sums = Invoke-Download "$baseUrl/SHASUMS256.txt"
        $line = ($sums -split "`n") | Where-Object { $_ -match ('\s' + [regex]::Escape($fileName) + '\s*$') } | Select-Object -First 1
        if (-not $line) { throw "Checksum for $fileName not found in SHASUMS256.txt." }
        $expectedHash = ($line.Trim() -split '\s+')[0].ToUpperInvariant()
        $actualHash = (Get-FileHash -Path $msiPath -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($actualHash -ne $expectedHash) { throw "Checksum mismatch for $fileName. The download may be corrupted or tampered with." }
        Write-Ok 'Checksum verified'
    }

    $signature = Get-AuthenticodeSignature -FilePath $msiPath
    if ($signature.Status -ne 'Valid') { throw "The Node.js installer's digital signature is not valid ($($signature.Status))." }
    Write-Ok "Signed by: $($signature.SignerCertificate.Subject -replace '^CN=([^,]+).*$', '$1')"

    $msiLog = Join-Path $DataDir 'nodejs-install.log'
    Write-Note 'Installing Node.js silently (this can take a minute)...'
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"{0}"' -f $msiPath), '/qn', '/norestart', '/l*v', ('"{0}"' -f $msiLog)) -Wait -PassThru
        if ($proc.ExitCode -ne 1618) { break }
        Write-Note 'Another installation (e.g. Windows Update) is running; waiting 30 seconds...'
        Start-Sleep -Seconds 30
    }
    if (@(0, 3010, 1641) -notcontains $proc.ExitCode) {
        throw "Node.js installation failed (msiexec exit code $($proc.ExitCode)). Details: $msiLog"
    }
    if ($proc.ExitCode -ne 0) { Write-Warn 'Node.js asked for a restart; the monitor will still work now.' }
    if (-not $NodeMsi) { Remove-Item $msiPath -Force -ErrorAction SilentlyContinue }
}

function Install-NodeWithWinget {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { return $false }
    Write-Note 'Trying winget instead...'
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $winget.Source install --id OpenJS.NodeJS.LTS --exact --silent --scope machine --accept-package-agreements --accept-source-agreements | Out-Host
        return ($LASTEXITCODE -eq 0)
    } finally { $ErrorActionPreference = $previous }
}

function Test-SamePath([string]$A, [string]$B) {
    try {
        return ([IO.Path]::GetFullPath($A).TrimEnd('\') -ieq [IO.Path]::GetFullPath($B).TrimEnd('\'))
    } catch { return $false }
}

# ------------------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------------------
$exitCode = 0
$transcript = $false
$tempRoot = $null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    try {
        Start-Transcript -Path (Join-Path $DataDir 'install.log') -Append | Out-Null
        $transcript = $true
    } catch { }

    Write-Host '==========================================================' -ForegroundColor Cyan
    Write-Host "  $AppName - Setup" -ForegroundColor Green
    Write-Host '==========================================================' -ForegroundColor Cyan
    Write-Note "Program folder: $InstallDir"
    Write-Note "Data folder:    $DataDir"

    # --- System checks ------------------------------------------------------------------
    Write-Step 'Checking this PC'
    if ([Environment]::OSVersion.Version -lt [version]'10.0') { throw 'Windows 10 / Windows Server 2016 or newer is required.' }
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'A 64-bit version of Windows is required (Node.js no longer supports 32-bit Windows).' }
    if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'Windows PowerShell 5.1 or newer is required.' }
    $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($InstallDir).Substring(0, 1)) -ErrorAction SilentlyContinue
    if ($drive -and $drive.Free -lt 500MB) { throw 'At least 500 MB of free disk space is required.' }
    Write-Ok "Windows $([Environment]::OSVersion.Version), PowerShell $($PSVersionTable.PSVersion), running as administrator"

    # --- Node.js -------------------------------------------------------------------------
    Write-Step 'Checking Node.js'
    # Only the machine-wide install in Program Files is used: the service runs as SYSTEM, so it
    # must never execute a node.exe from a folder that normal users can modify.
    $script:NodeExe = Join-Path (Get-ProgramFilesDir) 'nodejs\node.exe'
    $current = Get-NodeVersion $script:NodeExe
    $pinnedOk = $NodeVersion -and $current -and ($current -eq [version]$NodeVersion.TrimStart('v'))
    if (($current -and $current -ge $MinNode -and -not $NodeVersion) -or $pinnedOk) {
        Write-Ok "Node.js $current is already installed"
    } else {
        if ($current) { Write-Note "Node.js $current is installed; version $MinNode or newer is required. Upgrading..." }
        else { Write-Note 'Node.js is not installed. Installing it now...' }
        try {
            Install-NodeJs
        } catch {
            Write-Warn $_.Exception.Message
            if (-not (Install-NodeWithWinget)) {
                throw "Could not install Node.js. Check internet access to nodejs.org (use -Proxy if needed) or run with -NodeMsi <path to node-vXX-x64.msi>."
            }
        }
        $current = Get-NodeVersion $script:NodeExe
        if (-not $current -or $current -lt $MinNode) { throw "Node.js $MinNode+ is still not available at $($script:NodeExe)." }
        Write-Ok "Node.js $current installed"
    }

    # --- Application source ----------------------------------------------------------------
    Write-Step 'Getting the application files'
    $sourceDir = $PSScriptRoot
    if ($FromGitHub -or -not (Test-Path (Join-Path $sourceDir 'server.js'))) {
        $tempRoot = Join-Path $env:TEMP ("wanmon-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempRoot | Out-Null
        $zip = Join-Path $tempRoot 'app.zip'
        $zipUrl = "https://codeload.github.com/$Repository/zip/refs/heads/$Branch"
        Write-Note "Downloading $Repository ($Branch) from GitHub..."
        Invoke-Download $zipUrl $zip | Out-Null
        Expand-Archive -Path $zip -DestinationPath $tempRoot -Force
        $serverJs = Get-ChildItem -Path $tempRoot -Filter 'server.js' -Recurse -Depth 2 | Select-Object -First 1
        if (-not $serverJs) { throw 'The downloaded archive does not contain server.js.' }
        $sourceDir = $serverJs.DirectoryName
        Write-Ok 'Downloaded from GitHub'
    } else {
        Write-Ok "Using files from $sourceDir"
    }

    # --- Stop an existing installation ---------------------------------------------------------
    Write-Step 'Preparing installation'
    $oldWorkingDir = $null
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        Write-Note 'Stopping the running monitor (settings and history are kept)...'
        $oldWorkingDir = $existingTask.Actions[0].WorkingDirectory
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    $installedServer = Join-Path $InstallDir 'server.js'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$installedServer*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    # --- Copy the application ------------------------------------------------------------------
    Write-Step "Installing to $InstallDir"
    if (Test-SamePath $sourceDir $InstallDir) {
        Write-Note 'Running from the installed folder; files are already in place.'
    } else {
        if (Test-Path $InstallDir) {
            $isOurs = Test-Path (Join-Path $InstallDir 'server.js')
            $isEmpty = -not (Get-ChildItem -Path $InstallDir -Force | Select-Object -First 1)
            if (-not $isOurs -and -not $isEmpty) {
                throw "$InstallDir already exists and does not look like a $AppName installation. Choose another -InstallDir."
            }
            # Data lives in $DataDir, so the program folder can be replaced completely.
            Get-ChildItem -Path $InstallDir -Force | Remove-Item -Recurse -Force
        } else {
            New-Item -ItemType Directory -Path $InstallDir | Out-Null
        }
        $skip = @('.git', '.github', 'node_modules', 'install.json', 'wanmon.cmd')
        Get-ChildItem -Path $sourceDir -Force |
            Where-Object { $skip -notcontains $_.Name -and $_.Name -notlike '*.db' -and $_.Name -notlike '*.db-*' -and $_.Name -notlike '*.log' } |
            Copy-Item -Destination $InstallDir -Recurse -Force
    }
    Get-ChildItem -Path $InstallDir -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

    # Tell the app where its data lives, and add an admin helper command
    $installInfo = [ordered]@{
        dataDir     = $DataDir
        installedAt = (Get-Date).ToString('o')
        nodeExe     = $script:NodeExe
        source      = $(if ($FromGitHub) { "github:$Repository@$Branch" } else { 'local' })
    }
    # Written without a BOM (Windows PowerShell's -Encoding UTF8 adds one)
    [IO.File]::WriteAllText((Join-Path $InstallDir 'install.json'), ($installInfo | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    $helper = @"
@echo off
rem FortiGate WAN Monitor admin helper. Run from an Administrator command prompt.
rem   wanmon.cmd --set-password         set the dashboard password (enables remote access)
rem   wanmon.cmd --set-port 5000        change the port
rem   wanmon.cmd --show-webhook-token   print the webhook token
rem   wanmon.cmd restart, stop, start, status or logs
setlocal
set NODE_NO_WARNINGS=1
if /i "%~1"=="restart" ( schtasks /End /TN "$TaskName" >nul 2>&1 & ping -n 3 127.0.0.1 >nul & schtasks /Run /TN "$TaskName" & goto :eof )
if /i "%~1"=="stop"    ( schtasks /End /TN "$TaskName" & goto :eof )
if /i "%~1"=="start"   ( schtasks /Run /TN "$TaskName" & goto :eof )
if /i "%~1"=="status"  ( schtasks /Query /TN "$TaskName" /V /FO LIST & goto :eof )
if /i "%~1"=="logs"    ( powershell -NoProfile -Command "Get-Content -Tail 50 -Wait '$DataDir\monitor.log'" & goto :eof )
"$($script:NodeExe)" "%~dp0server.js" %*
"@
    $helper = $helper -replace "`r?`n", "`r`n"   # batch files need CRLF line endings
    [IO.File]::WriteAllText((Join-Path $InstallDir 'wanmon.cmd'), $helper, [Text.Encoding]::ASCII)
    Write-Ok 'Application files installed'

    # --- Data folder: migrate v1 database, restrict access --------------------------------------
    Write-Step 'Setting up the data folder'
    $dbPath = Join-Path $DataDir 'monitor.db'
    if (-not (Test-Path $dbPath)) {
        $candidates = @()
        if ($oldWorkingDir) { $candidates += (Join-Path $oldWorkingDir 'monitor.db') }
        $candidates += (Join-Path $PSScriptRoot 'monitor.db')
        $legacy = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($legacy) {
            foreach ($suffix in @('', '-wal', '-shm')) {
                if (Test-Path "$legacy$suffix") { Copy-Item "$legacy$suffix" "$dbPath$suffix" -Force }
            }
            Write-Ok "Imported existing settings and history from $legacy"
        }
    }
    # The database holds the FortiGate API token and alert credentials: Administrators and SYSTEM only.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C /Q | Out-Null
    $ErrorActionPreference = $previous
    Write-Ok 'Access restricted to Administrators and SYSTEM'

    # --- Port and password -----------------------------------------------------------------------
    Write-Step 'Configuring'
    if ($Port -gt 0) {
        if ($Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
        Invoke-App @('--set-port', "$Port") | Out-Null
    }
    $portText = Invoke-App @('--get-port')
    $appPort = 4000
    if ($portText -match '(\d+)\s*$') { $appPort = [int]$Matches[1] }
    Write-Ok "Listening port: $appPort"

    if (-not $DashboardPassword -and $PromptForPassword -and -not $Silent) {
        Write-Host ''
        Write-Host '    Set a dashboard password to allow access from other PCs (min 8 characters).' -ForegroundColor White
        Write-Host '    Press Enter to skip (the dashboard then only works on this PC).' -ForegroundColor Gray
        $DashboardPassword = Read-Host -AsSecureString '    Dashboard password'
    }
    if ($DashboardPassword -and $DashboardPassword.Length -gt 0) {
        if ($DashboardPassword.Length -lt 8) {
            Write-Warn 'Password too short (min 8 characters); not set. Set it later with: wanmon.cmd --set-password'
        } else {
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($DashboardPassword)
            try {
                $env:WANMON_NEW_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
                Invoke-App @('--set-password') | Out-Null
                Write-Ok 'Dashboard password set (user: admin)'
            } finally {
                Remove-Item Env:\WANMON_NEW_PASSWORD -ErrorAction SilentlyContinue
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            }
        }
    }

    # --- Firewall ------------------------------------------------------------------------------
    Write-Step 'Windows Firewall'
    Get-NetFirewallRule -DisplayName 'FortiGate WAN Monitor (Port *)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    if ($NoFirewall) {
        Write-Note 'Skipped (-NoFirewall). Only this PC can reach the dashboard.'
    } else {
        New-NetFirewallRule -DisplayName "FortiGate WAN Monitor (Port $appPort)" -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort $appPort -RemoteAddress $FirewallRemoteAddress `
            -Description 'Dashboard and FortiGate webhook for FortiGate WAN Monitor' | Out-Null
        Write-Ok "Inbound TCP $appPort allowed from: $FirewallRemoteAddress"
    }

    # --- Background task -----------------------------------------------------------------------
    Write-Step 'Registering the 24/7 background task'
    $action = New-ScheduledTaskAction -Execute $script:NodeExe -Argument ('"{0}"' -f $installedServer) -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
        -Description "Runs $AppName 24/7 (starts at boot, restarts on failure)." | Out-Null
    Write-Ok "Task '$TaskName' runs at startup as SYSTEM and restarts automatically"

    # --- Shortcuts -------------------------------------------------------------------------------
    $startMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
    Set-Content -Path (Join-Path $startMenu "$AppName.url") -Value "[InternetShortcut]`r`nURL=http://localhost:$appPort/" -Encoding ASCII
    Set-Content -Path (Join-Path $startMenu "$AppName Help.url") -Value "[InternetShortcut]`r`nURL=http://localhost:$appPort/help.html" -Encoding ASCII

    # --- Start and verify ------------------------------------------------------------------------
    if ($NoStart) {
        Write-Step 'Not starting the monitor (-NoStart). It will start at the next boot.'
    } else {
        Write-Step 'Starting the monitor'
        Start-ScheduledTask -TaskName $TaskName
        $up = $false
        for ($i = 0; $i -lt 30 -and -not $up; $i++) {
            Start-Sleep -Seconds 1
            $up = Test-PortListening $appPort
        }
        if (-not $up) {
            throw "The monitor did not start listening on port $appPort. See $(Join-Path $DataDir 'monitor.log')"
        }
        Write-Ok "Monitor is running on port $appPort"
    }

    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress

    Write-Host ''
    Write-Host '==========================================================' -ForegroundColor Green
    Write-Host "  $AppName is installed" -ForegroundColor Green
    Write-Host '==========================================================' -ForegroundColor Green
    Write-Host "  Dashboard (this PC):  http://localhost:$appPort"
    if ($ip) { Write-Host "  Dashboard (network):  http://${ip}:$appPort  (needs a dashboard password)" }
    Write-Host "  Setup guide:          http://localhost:$appPort/help.html#connect"
    Write-Host "  Admin commands:       `"$InstallDir\wanmon.cmd`" --set-password | restart | status | logs"
    Write-Host "  Logs:                 $DataDir"
    Write-Host ''
    Write-Host '  Next: open the setup guide and connect the monitor to your FortiGate.' -ForegroundColor Cyan
} catch {
    $exitCode = 1
    Write-Host ''
    Write-Host "SETUP FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Install log: $(Join-Path $DataDir 'install.log')" -ForegroundColor Yellow
} finally {
    if ($tempRoot -and (Test-Path $tempRoot)) { Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if ($transcript) { try { Stop-Transcript | Out-Null } catch { } }
}

if (-not $Silent) {
    Write-Host ''
    Read-Host 'Press Enter to close' | Out-Null
}
exit $exitCode
