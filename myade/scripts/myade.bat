@echo off
REM myade - launches `claude` while registering this terminal/pane with the
REM local myade server (starting the server first if it isn't already
REM running). All actual logic lives in register.js so this file stays
REM tiny and easy to trust.
REM
REM Usage: myade [any claude CLI arguments]
REM Optional: set MYADE_LABEL=my-label   (before running) to name this pane
REM Optional: set MYADE_PORT=1234        (before running) to use a non-default port

setlocal

set "MYADE_SCRIPTS_DIR=%~dp0"
set "MYADE_PANE_ID="

for /f "usebackq delims=" %%p in (`node "%MYADE_SCRIPTS_DIR%register.js" start`) do set "MYADE_PANE_ID=%%p"

claude %*

if defined MYADE_PANE_ID (
  node "%MYADE_SCRIPTS_DIR%register.js" end "%MYADE_PANE_ID%"
)

endlocal
