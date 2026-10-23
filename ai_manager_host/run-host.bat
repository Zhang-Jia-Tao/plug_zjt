@echo off
rem run-host.bat - Chrome Native Messaging host launcher
rem Chrome can only start an executable, so the node script needs this wrapper.
cd /d "%~dp0"
node host.mjs
