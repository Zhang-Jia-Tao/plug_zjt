@echo off
rem uninstall-host.bat - remove Chrome/Edge Native Messaging registration for this host
rem The tracked template is never deleted; only the machine-local generated manifest is removed.

setlocal
set HOST_DIR=%~dp0
set MANIFEST=%HOST_DIR%com.zjt.ai_manager.local.json
set CHROME_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\ai_manager_host
set EDGE_KEY=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\ai_manager_host

reg delete "%CHROME_KEY%" /f >nul 2>&1
reg delete "%EDGE_KEY%" /f >nul 2>&1
if exist "%MANIFEST%" del /f /q "%MANIFEST%" >nul 2>&1

echo uninstalled Chrome/Edge Native Messaging registration.
echo reload the extension in chrome://extensions to drop the host connection.
endlocal
