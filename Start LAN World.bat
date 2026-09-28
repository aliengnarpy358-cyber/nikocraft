@echo off
title Nikocraft - LAN World
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js is required to host a LAN world, but it was not found.
    echo   Install it from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)

set PORT=6767
node "%~dp0lan-server.js"

echo.
echo   Server stopped.
pause
