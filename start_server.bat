@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

echo 正在启动服务集群...

:: 获取脚本所在目录（避免从不同目录启动时路径错误）
cd /d "%~dp0"

:: LLM 线级抓取（开发调试基础设施）：记录发给 provider 的请求与原始响应（含 SSE 逐字节）。
:: 产物在 %~dp0llm-wire-logs（按天 JSONL）；查看：npm run llm:wire-report -- --usage-shapes
:: 注意：请求体含用户对话内容且落盘不自动清理，日常不需要排障时把下行改为 0。
set "RAGSYSTEM_LLM_WIRE_CAPTURE=0"
echo [调试] LLM 线级抓取已开启，目录: %RAGSYSTEM_LLM_WIRE_CAPTURE%

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
