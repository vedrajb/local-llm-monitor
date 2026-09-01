@echo off
setlocal

rem Restarts the Ollama tray app with the settings the monitor's metrics depend
rem on. Full reasoning for every value: ollama-setup-windows.md, step 2.
rem
rem The variables are set here as well as by setx so this launcher is
rem self-contained: the tray app inherits them from this process. Keep the setx
rem values in sync, otherwise launching Ollama from the Start menu gets the
rem defaults instead.

set "OLLAMA_CONTEXT_LENGTH=16384"
set "OLLAMA_NUM_PARALLEL=4"
set "OLLAMA_KEEP_ALIVE=-1"
set "OLLAMA_FLASH_ATTENTION=1"
set "OLLAMA_KV_CACHE_TYPE=q8_0"

set "OLLAMA_APP=%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
set "OLLAMA_LOG=%LOCALAPPDATA%\Ollama\server.log"

if not exist "%OLLAMA_APP%" (
  echo.
  echo   Not found: %OLLAMA_APP%
  echo   See ollama-setup-windows.md, step 1.
  echo.
  exit /b 1
)

rem NUM_PARALLEL x CONTEXT_LENGTH is the real KV allocation, not CONTEXT_LENGTH.
set /a KV=%OLLAMA_NUM_PARALLEL% * %OLLAMA_CONTEXT_LENGTH%
echo Restarting Ollama: %OLLAMA_NUM_PARALLEL% parallel x %OLLAMA_CONTEXT_LENGTH% ctx = %KV% tokens of KV (%OLLAMA_KV_CACHE_TYPE%)
echo.

rem The tray app reads OLLAMA_* once at startup, so a restart is the only way to
rem apply a change. Access-denied here is expected from non-interactive shells;
rem run this window normally if that happens.
taskkill /F /IM "ollama app.exe" >nul 2>&1
taskkill /F /IM ollama.exe >nul 2>&1
timeout /t 3 /nobreak >nul

start "" "%OLLAMA_APP%"

rem Wait for the API rather than trusting the exit code above.
echo Waiting for http://127.0.0.1:11434 ...
set "UP="
for /l %%i in (1,1,20) do (
  if not defined UP (
    curl -s -m 2 http://127.0.0.1:11434/api/version >nul 2>&1
    if not errorlevel 1 set "UP=1"
    if not defined UP timeout /t 1 /nobreak >nul
  )
)

if not defined UP (
  echo   Server did not answer. Quit Ollama from the tray icon and relaunch it
  echo   from the Start menu - see the access-denied note in ollama-setup-windows.md.
  exit /b 1
)

echo   up.
echo.

rem This is the check that catches a silently-failed restart: a server that
rem missed the variables logs the defaults (CONTEXT_LENGTH:0, NUM_PARALLEL:1,
rem KEEP_ALIVE:5m0s). KEEP_ALIVE:2562047h47m... is -1 applied correctly.
echo Settings the server actually loaded:
powershell -NoProfile -Command "$p=$env:LOCALAPPDATA+'\Ollama\server.log'; if (Test-Path $p) { (Select-String -Path $p -Pattern 'OLLAMA_(CONTEXT_LENGTH|NUM_PARALLEL|KEEP_ALIVE|FLASH_ATTENTION|KV_CACHE_TYPE):[^ ]*' -AllMatches).Matches | ForEach-Object { $_.Value } | Select-Object -Last 5 | ForEach-Object { '  ' + $_ } } else { '  no server.log at ' + $p }"

endlocal
