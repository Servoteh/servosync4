@echo off
REM ==========================================================
REM TSPL2 raw proxy launcher (Windows)
REM ==========================================================
REM Pokreni dvoklikom ili iz CMD-a:
REM    start.bat
REM
REM ENV varijable mozes da postavis pre poziva, npr:
REM    set PRINTER_HOST=192.168.70.20
REM    set PROXY_PORT=8765
REM    start.bat
REM ==========================================================

cd /d "%~dp0"

if "%PRINTER_HOST%"=="" set PRINTER_HOST=192.168.70.20
if "%PRINTER_PORT%"=="" set PRINTER_PORT=9100
if "%PROXY_PORT%"==""   set PROXY_PORT=8765

title TSPL2 Proxy [%PRINTER_HOST%:%PRINTER_PORT%]

echo.
echo Starting TSPL2 proxy...
echo   Printer: %PRINTER_HOST%:%PRINTER_PORT%
echo   Proxy:   http://localhost:%PROXY_PORT%
echo.
echo Pritisni Ctrl+C za stop.
echo.

node label-proxy.mjs

REM Ako Node nije nadjen, pokazi link za download:
if errorlevel 9009 (
  echo.
  echo NODE.JS nije instaliran ili nije u PATH.
  echo Skini i instaliraj LTS sa: https://nodejs.org/
  pause
)
