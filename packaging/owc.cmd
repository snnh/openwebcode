@echo off
rem OpenWebCode launcher for the Windows MSI layout.
rem Keep this file ASCII-only: cmd.exe parses batch files in the OEM codepage
rem and non-ASCII bytes can break parsing. CI converts it to CRLF into bin\.
setlocal
set "OWC_HOME=%~dp0.."
set "OWC_CORE_PATH=%OWC_HOME%\bin\owc-exec.exe"
if not defined OWC_PORT set "OWC_PORT=3210"
rem One-time migration of the legacy default data directory.  Runs only when
rem OWC_DATA_DIR is not set explicitly, the legacy dir exists, and the new
rem default dir does not.  Never blocks startup.
if not defined OWC_DATA_DIR (
    if exist "%LOCALAPPDATA%\openwebcode" if not exist "%USERPROFILE%\openwebcode" (
        move "%LOCALAPPDATA%\openwebcode" "%USERPROFILE%\openwebcode" >nul 2>&1
        if errorlevel 1 robocopy "%LOCALAPPDATA%\openwebcode" "%USERPROFILE%\openwebcode" /E /MOVE >nul 2>&1
        if exist "%USERPROFILE%\openwebcode" (
            echo migrated from %LOCALAPPDATA%\openwebcode> "%USERPROFILE%\openwebcode\.migrated-from-localappdata"
        ) else (
            echo owc.cmd: warning: could not migrate data from "%LOCALAPPDATA%\openwebcode" to "%USERPROFILE%\openwebcode"; starting with a fresh data directory. 1>&2
        )
    )
    set "OWC_DATA_DIR=%USERPROFILE%\openwebcode"
)
if exist "%OWC_HOME%\node\node.exe" (set "OWC_NODE=%OWC_HOME%\node\node.exe") else (
    echo owc.cmd: warning: bundled node.exe not found under "%OWC_HOME%\node", falling back to Node.js from PATH. 1>&2
    set "OWC_NODE=node"
)
rem "owc run ..." goes to the headless CLI; anything else starts the server.
if /i "%~1"=="run" (set "OWC_TARGET=cli.js") else (set "OWC_TARGET=index.js")
"%OWC_NODE%" "%OWC_HOME%\server\dist\%OWC_TARGET%" %*
rem Keep the console visible on server failure (e.g. port already in use);
rem the headless "owc run" path must not pause (CI).
if /i "%OWC_TARGET%"=="index.js" if errorlevel 1 pause
