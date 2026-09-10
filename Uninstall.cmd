@echo off
rem Double-click to remove FortiGate WAN Monitor (settings and history are kept).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
