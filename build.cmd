@echo off
setlocal
cd /d "%~dp0"
set "LOG=%~dp0build-log.txt"
title Talabia build
echo.
echo  Building Talabia... please wait, do not close this window.
echo  Details are written to build-log.txt
echo.
echo === build %DATE% %TIME% === > "%LOG%"

where node >nul 2>nul
if errorlevel 1 (
  echo NODE NOT FOUND >> "%LOG%"
  echo  ERROR: Node.js is not installed or not on PATH.
  goto end
)

echo [1/4] close any running copy >> "%LOG%"
taskkill /IM Talabia.exe /F >nul 2>nul
taskkill /IM Daftar.exe /F >nul 2>nul
taskkill /IM CHEZZZ.exe /F >nul 2>nul
timeout /t 2 /nobreak >nul

echo [2/4] package and install >> "%LOG%"
echo  [1/3] Packaging and installing (a few minutes)...
node tools\build-unified.js >> "%LOG%" 2>&1
if errorlevel 1 (
  echo BUILD FAILED >> "%LOG%"
  echo  BUILD FAILED - see build-log.txt
  goto end
)

echo [3/4] the real Supabase project >> "%LOG%"
echo  [2/3] Checking the Supabase project...
node tools\check-cloud-live.js >> "%LOG%" 2>&1

echo [4/4] tests >> "%LOG%"
echo  [3/3] Running tests...
node tools\test-store.js >> "%LOG%" 2>&1
node tools\test-workspace.js >> "%LOG%" 2>&1
node tools\test-cloud.js >> "%LOG%" 2>&1
node tools\test-catalog-cloud.js >> "%LOG%" 2>&1
node tools\test-coverage-sync.js >> "%LOG%" 2>&1
set "DAFTAR_EXE=%~dp0dist\win-unpacked\Talabia.exe"
node tools\test-recipes.js >> "%LOG%" 2>&1
node tools\test-fonts.js >> "%LOG%" 2>&1
node tools\test-branches.js >> "%LOG%" 2>&1
node tools\test-brands.js >> "%LOG%" 2>&1
node tools\test-import.js >> "%LOG%" 2>&1
node tools\test-digits.js >> "%LOG%" 2>&1
node tools\test-dates.js >> "%LOG%" 2>&1
node tools\test-smart-import.js >> "%LOG%" 2>&1
node tools\test-cloud-app.js >> "%LOG%" 2>&1
node tools\test-session.js >> "%LOG%" 2>&1
node tools\test-lang.js >> "%LOG%" 2>&1
node tools\test-zero-missing.js >> "%LOG%" 2>&1
node tools\test-similar.js >> "%LOG%" 2>&1
node tools\test-intel.js >> "%LOG%" 2>&1
node tools\test-ai.js >> "%LOG%" 2>&1
node tools\test-market.js >> "%LOG%" 2>&1
node tools\test-screens.js >> "%LOG%" 2>&1
set "DAFTAR_EXE="
echo.
echo  DONE. Talabia is installed - open it from the Desktop.
echo  The installer is in the "installer" folder.

:end
echo === done %DATE% %TIME% === >> "%LOG%"
echo.
pause
