@echo off
rem install-host.bat - one-time setup: generate host manifest + register HKCU registry key
rem usage: install-host.bat <extension_id>
rem extension id: chrome://extensions -> "Custom New Tab" card (developer mode)

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
set MANIFEST=%HOST_DIR%\com.zjt.ai_manager.json

rem generate host manifest (only the given extension may connect).
rem written via PowerShell ConvertTo-Json so paths containing )/&/spaces stay intact,
rem and via WriteAllText so the file is UTF-8 without BOM (Chrome rejects BOM manifests).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$m = [ordered]@{ name = 'ai_manager_host'; description = 'Local AI app manager host'; path = '%BAT%'; type = 'stdio'; allowed_origins = @('chrome-extension://%EXT_ID%/') }; [System.IO.File]::WriteAllText('%MANIFEST%', ($m | ConvertTo-Json))"
if not exist "%MANIFEST%" (
  echo failed to generate host manifest
  exit /b 1
)

rem write registry key (HKCU, no admin needed)
set KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\ai_manager_host
reg add "%KEY%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
if errorlevel 1 (
  echo failed to write registry key
  exit /b 1
)

echo done. host manifest: %MANIFEST%
echo registered: %KEY%
echo reload the extension in chrome://extensions, then open a new tab
echo (AI manager handle appears on the left edge)
endlocal
