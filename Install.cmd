@echo off
rem Double-click to install or upgrade FortiGate WAN Monitor.
rem Windows will ask for administrator permission (UAC) once.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
