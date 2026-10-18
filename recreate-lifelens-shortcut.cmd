@echo off
REM ============================================================
REM  Rebuild the LifeLens desktop shortcut (the proper way).
REM  Double-click this file. Needs no arguments.
REM  Paths are resolved from this script's own location,
REM  so it works wherever you cloned / unpacked LifeLens.
REM ============================================================
setlocal
set "ROOT=%~dp0"
REM %~dp0 keeps a trailing backslash; strip it so we can build clean paths
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "EXE=%ROOT%\dist\LifeLens.exe"

powershell -NoProfile -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$exe='%EXE%';" ^
  "$root='%ROOT%';" ^
  "if (-not (Test-Path $exe)) { Write-Host \"ERROR: $exe not found. Run 'npm run dist' in $root first.\" -ForegroundColor Red; exit 1 };" ^
  "$ws=New-Object -ComObject WScript.Shell;" ^
  "$d=[Environment]::GetFolderPath('Desktop');" ^
  "$sc=$ws.CreateShortcut($d+'\LifeLens.lnk');" ^
  "$sc.TargetPath=$exe;" ^
  "$sc.WorkingDirectory=$root;" ^
  "$sc.IconLocation=\"$exe,0\";" ^
  "$sc.Hotkey='Ctrl+Alt+L';" ^
  "$sc.Description='LifeLens';" ^
  "$sc.Save();" ^
  "Write-Host ('OK: shortcut created at ' + $d + '\LifeLens.lnk  (target: ' + $exe + ')') -ForegroundColor Green"
echo.
echo Done. You can close this window and double-click the LifeLens icon on your desktop.
pause
endlocal
