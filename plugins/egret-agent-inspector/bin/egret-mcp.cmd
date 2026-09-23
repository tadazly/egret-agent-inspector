@echo off
rem MCP launcher for the Claude Code plugin on Windows: run the server with a Python 3.8+.
rem Same candidates and version check as scripts/start_mcp.js: EGRET_PYTHON, python, py -3, python3.
rem The python / python3 stubs under WindowsApps fail the version check and are skipped.
rem Keep this file ASCII-only: cmd.exe parses it in the console code page.
setlocal
set "SERVER=%~dp0..\server\egret_agent_inspector_mcp.py"
rem Leave the plugin cache directory: Windows locks the working directory and uninstall fails.
cd /d "%USERPROFILE%" 2>nul
if defined EGRET_PYTHON call :run "%EGRET_PYTHON%"
call :run python
call :run py -3
call :run python3
>&2 echo Egret Agent Inspector needs Python 3.8+: no usable python, py -3 or python3 found ^(set EGRET_PYTHON to override^).
exit 1

:run
%* -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1 || exit /b 0
%* "%SERVER%"
exit %ERRORLEVEL%
