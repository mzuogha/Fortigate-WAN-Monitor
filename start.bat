@echo off
title FortiGate Dual-WAN Link Monitor
cd /d "%~dp0"

echo ========================================================
echo   FortiGate Dual-WAN Link Monitor & Failover Guard
echo ========================================================
echo.

:: Check for node or agy-node
where agy-node.cmd >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Using Antigravity Node runtime (agy-node.cmd)
    agy-node.cmd server.js
    goto end
)

where node.exe >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Using system Node.js (node.exe)
    node.exe server.js
    goto end
)

if exist "%APPDATA%\Antigravity\agy-node.cmd" (
    echo [OK] Using Antigravity Node runtime from AppData
    call "%APPDATA%\Antigravity\agy-node.cmd" server.js
    goto end
)

echo [ERROR] Neither Node.js nor agy-node.cmd was found on your system.
echo Please install Node.js from https://nodejs.org or via winget:
echo winget install OpenJS.NodeJS
pause

:end
