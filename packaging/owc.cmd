@echo off
rem OpenWebCode launcher for the Windows MSI layout.
rem Keep this file ASCII-only: cmd.exe parses batch files in the OEM codepage
rem and non-ASCII bytes can break parsing. CI converts it to CRLF into bin\.
setlocal
set "OWC_HOME=%~dp0.."
set "OWC_CORE_PATH=%OWC_HOME%\bin\owc-exec.exe"
if not defined OWC_PORT set "OWC_PORT=3000"
if not defined OWC_DATA_DIR set "OWC_DATA_DIR=%LOCALAPPDATA%\openwebcode"
if exist "%OWC_HOME%\node\node.exe" (set "OWC_NODE=%OWC_HOME%\node\node.exe") else (set "OWC_NODE=node")
rem "owc run ..." goes to the headless CLI; anything else starts the server.
if /i "%~1"=="run" (set "OWC_TARGET=cli.js") else (set "OWC_TARGET=index.js")
"%OWC_NODE%" "%OWC_HOME%\server\dist\%OWC_TARGET%" %*
rem Keep the console visible on server failure (e.g. port already in use);
rem the headless "owc run" path must not pause (CI).
if /i "%OWC_TARGET%"=="index.js" if errorlevel 1 pause
