@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

echo 正在启动服务集群...

:: 获取脚本所在目录（避免从不同目录启动时路径错误）
cd /d "%~dp0"

:: 1. 客户端服务
if exist "frontend-client\" (
    echo [1/2] 启动客户端服务...
    start "客户端服务" cmd /k "cd /d "%~dp0frontend-client" && npm run dev"
) else (
    echo [错误] 找不到 frontend-client 目录，路径: "%~dp0frontend-client"
)

timeout /t 1 /nobreak >nul

:: 2. 后端服务
if exist "backend-fastapi\" (
    echo [2/2] 启动 FastAPI 后端服务...
    start "FastAPI后端服务" cmd /k "cd /d "%~dp0backend-fastapi" && call conda activate ragsystem-fastapi && python main.py"
) else (
    echo [错误] 找不到 backend-fastapi 目录
)

echo 所有服务已尝试启动
exit
