@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo Missing runtime\node.exe. Extract the entire ZIP archive first.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0server.mjs"
if errorlevel 1 pause
