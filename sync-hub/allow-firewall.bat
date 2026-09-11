@echo off
title SxyBrick Hub - Allow firewall port

:: Purpose: allow inbound TCP for the sync hub (default 18080).
:: Fixes: PC browser opens the hub fine, but phone/tablet times out.
:: Usage: right-click this file -> "Run as administrator" (once is enough).

set PORT=18080
if not "%~1"=="" set PORT=%~1

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo  [X] Administrator rights required.
  echo      Right-click this file and choose "Run as administrator", then try again.
  echo.
  pause
  exit /b 1
)

echo.
echo  Allowing inbound TCP port %PORT% for all profiles ^(Domain/Private/Public^)...
echo.

netsh advfirewall firewall delete rule name="SxyBrick Hub %PORT%" >nul 2>&1
netsh advfirewall firewall add rule name="SxyBrick Hub %PORT%" dir=in action=allow protocol=TCP localport=%PORT% profile=any

if %errorlevel%==0 (
  echo.
  echo  [OK] Done. Now open on your phone:  http://^<PC-IP^>:%PORT%
  echo       The address MUST include :%PORT%  ^(without the port you will hit IIS on port 80^).
  echo.
  echo  Different port? run again with:  allow-firewall.bat 18081
) else (
  echo.
  echo  [X] Failed. Run this manually as administrator:
  echo      netsh advfirewall firewall add rule name="SxyBrick Hub %PORT%" dir=in action=allow protocol=TCP localport=%PORT% profile=any
)
echo.
pause
