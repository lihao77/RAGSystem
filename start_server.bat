@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

echo 正在启动服务集群...

:: 获取脚本所在目录（避免从不同目录启动时路径错误）
cd /d "%~dp0"

:: 1. TypeScript 后端服务
if exist "backend-local\" (
    echo [1/2] 启动 TypeScript 后端服务...
    start "TypeScript后端服务" cmd /k "cd /d ""%~dp0"" && npm run dev:backend-local"
) else (
    echo [错误] 找不到 backend-local 目录
)

timeout /t 1 /nobreak >nul

:: 2. 客户端服务
if exist "frontend-client\" (
    echo [2/2] 启动客户端服务...
    start "客户端服务" cmd /k "cd /d ""%~dp0frontend-client"" && npm run dev"
) else (
    echo [错误] 找不到 frontend-client 目录，路径: "%~dp0frontend-client"
)

echo 所有服务已尝试启动
exit
