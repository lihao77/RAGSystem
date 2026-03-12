@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

echo 正在启动服务集群...

:: 获取脚本所在目录（避免从不同目录启动时路径错误）
cd /d "%~dp0"

:: 1. 前端服务
if exist "frontend\" (
    echo [1/3] 启动前端服务...
    start "前端服务" cmd /k "cd /d "%~dp0frontend" && npm run dev"
) else (
    echo [错误] 找不到 frontend 目录
)

timeout /t 1 /nobreak >nul

:: 2. 客户端服务
if exist "frontend-client\" (
    echo [2/3] 启动客户端服务...
    start "客户端服务" cmd /k "cd /d "%~dp0frontend-client" && npm run dev"
) else (
    echo [错误] 找不到 frontend-client 目录，路径: "%~dp0frontend-client"
    dir /b | findstr "frontend"  :: 列出当前目录下含 frontend 的文件夹供排查
)

timeout /t 1 /nobreak >nul

:: 3. 后端服务（优先 FastAPI 版）
if exist "backend-fastapi\" (
    echo [3/3] 启动 FastAPI 后端服务...
    start "FastAPI后端服务" cmd /k "cd /d "%~dp0backend-fastapi" && call conda activate ragsystem && python main.py"
) else (
    if exist "backend\" (
        echo [3/3] 启动后端服务...
        start "后端服务" cmd /k "cd /d "%~dp0backend" && call conda activate ragsystem && python app.py"
    ) else (
        echo [错误] 找不到 backend-fastapi 或 backend 目录
    )
)

echo 所有服务已尝试启动
exit
