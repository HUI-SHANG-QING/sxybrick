@echo off
title SxyBrick Hub - LAN sync (GitHub Pages allowed)

:: Start the LAN sync hub with CORS allowance for the GitHub Pages site,
:: so an Android phone can sync DIRECTLY from the HTTPS GitHub page
:: (no need to switch to the hub page).
::
:: Usage: double-click this file (no admin needed).
:: Change HUB_ALLOW_ORIGIN below if your Pages domain is different.
:: Multiple origins: separate with commas, e.g. https://a.github.io,https://b.github.io

cd /d "%~dp0.."

set PORT=18080
set HUB_ALLOW_ORIGIN=https://hui-shang-qing.github.io

echo ============================================================
echo   SxyBrick sync hub
echo   Port            : %PORT%
echo   Extra CORS allow: %HUB_ALLOW_ORIGIN%
echo ============================================================
echo.

node sync-hub/hub.js %PORT%

echo.
echo Hub stopped. Press any key to close...
pause >nul
