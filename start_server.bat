@echo off
if exist .\frontend\ (
    start "前端服务" cmd /k "cd .\frontend && npm run dev"
) else (
    echo 错误：找不到前端目录
)

if exist .\backend\ (
    start "后端服务" cmd /k "cd .\backend && conda activate ragsystem && python app.py"
) else (
    echo 错误：找不到后端目录
)

exit