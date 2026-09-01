@echo off
setlocal

rem Starts llama-server for the Local LLM Monitor.
rem Setup and the reasoning behind each flag: llamacpp-setup-windows.md

set "MODEL=Qwen/Qwen3-8B-GGUF:Q8_0"
set "ALIAS=qwen3-8b-q8"
set "BIND=127.0.0.1"
set "PORT=8080"

rem -c is the TOTAL KV pool and is divided across slots, then capped at the
rem model's trained context (40960 for Qwen3-8B). -np is left explicit because
rem its default is -1 (auto): a bare "-c 32768" can silently become four
rem 8192-token slots instead of one 32768-token slot.
set "CTX=32768"
set "SLOTS=1"

where llama-server >nul 2>&1
if errorlevel 1 (
  echo.
  echo   llama-server is not on PATH.
  echo   Add %%USERPROFILE%%\workspace\_ai\llamacpp to Path, then reopen this window.
  echo   See llamacpp-setup-windows.md, step 3.
  echo.
  exit /b 1
)

echo Starting llama-server on http://%BIND%:%PORT%  (%SLOTS% slot^(s^) x %CTX% ctx)
echo Ctrl-C to stop.  VRAM is released on exit.
echo.

rem --metrics is off by default and the monitor needs it for throughput and
rem prefix reuse. -fa on forces flash attention so an unavailable one errors
rem instead of silently falling back.
llama-server ^
  -hf %MODEL% ^
  --alias %ALIAS% ^
  --host %BIND% --port %PORT% ^
  -c %CTX% -np %SLOTS% ^
  -ngl all ^
  -fa on ^
  --metrics

endlocal
