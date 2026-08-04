@echo off
rem OpenWebCode post-install launcher for the Windows MSI "Launch" checkbox.
rem Starts the server in a minimized console, then opens the web UI in the
rem default browser. Keep this file ASCII-only: cmd.exe parses batch files in
rem the OEM codepage and non-ASCII bytes can break parsing. CI converts it to
rem CRLF into bin\.
setlocal
if not defined OWC_PORT set "OWC_PORT=3210"
start "" /min "%~dp0owc.cmd"
rem Give the server a moment to bind the port before opening the browser.
timeout /t 3 /nobreak >nul
start "" "http://localhost:%OWC_PORT%"
