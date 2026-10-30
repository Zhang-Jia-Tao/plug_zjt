@echo off
rem install-host.bat - one-time setup: generate a machine-local host manifest + register Chrome/Edge
rem usage: install-host.bat <extension_id>
rem extension id: chrome://extensions -> "Custom New Tab" card (developer mode)
rem
rem The tracked com.zjt.ai_manager.json is a template. This script never edits it;
rem it writes com.zjt.ai_manager.local.json (gitignored) with this machine's absolute path.

setlocal
set EXT_ID=%~1
if "%EXT_ID%"=="" (
  echo usage: install-host.bat ^<extension_id^>
  echo extension id: chrome://extensions "Custom New Tab" card, needs developer mode
  exit /b 1
)

set HOST_DIR=%~dp0
rem strip trailing backslash (json paths use forward slashes)
set HOST_DIR=%HOST_DIR:~0,-1%
set HOST_DIR_JSON=%HOST_DIR:\=/%
set BAT=%HOST_DIR_JSON%/run-host.bat
set MANIFEST=%HOST_DIR%\com.zjt.ai_manager.local.json

rem Generate the host manifest (only the given extension may connect).
rem Written via PowerShell ConvertTo-Json so paths containing )/&/spaces stay intact,
rem and via WriteAllText so the file is UTF-8 without BOM (Chrome rejects BOM manifests).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$m = [ordered]@{ name = 'ai_manager_host'; description = 'Local AI app manager host'; path = '%BAT%'; type = 'stdio'; allowed_origins = @('chrome-extension://%EXT_ID%/') }; [System.IO.File]::WriteAllText('%MANIFEST%', ($m | ConvertTo-Json))"
if not exist "%MANIFEST%" (
  echo failed to generate host manifest
  exit /b 1
)

rem Register both Chrome and Edge under HKCU (no admin needed).
rem Edge users would otherwise load the extension but never connect to the host.
set CHROME_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\ai_manager_host
set EDGE_KEY=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\ai_manager_host
reg add "%CHROME_KEY%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
if errorlevel 1 (
  echo failed to write Chrome registry key
  exit /b 1
)
reg add "%EDGE_KEY%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
if errorlevel 1 (
  echo warning: failed to write Edge registry key; Chrome registration is still usable
) else (
  echo registered: %EDGE_KEY%
)

echo done. host manifest: %MANIFEST%
echo registered: %CHROME_KEY%
echo reload the extension in chrome://extensions, then open a new tab
echo (AI manager handle appears on the left edge)
endlocal
