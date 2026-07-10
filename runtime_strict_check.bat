@echo off
call npm run check:packages || exit /b 1
call npm run check:backend || exit /b 1
call npm run check:frontend || exit /b 1
call npm run check:widget || exit /b 1
