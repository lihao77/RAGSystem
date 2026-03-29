# RAGSystem backend FastAPI Dockerfile
FROM python:3.11-slim

WORKDIR /app

# 基础依赖
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 业务代码
COPY . .

# 端口与环境
ENV FASTAPI_HOST=0.0.0.0
ENV FASTAPI_PORT=5001
ENV FASTAPI_RELOAD=false

EXPOSE 5001

# 生产模式：多 worker，关闭自动 reload
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5001", "--workers", "4"]
