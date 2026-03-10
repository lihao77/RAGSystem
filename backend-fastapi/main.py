# -*- coding: utf-8 -*-
"""
智能体系统 FastAPI 后端入口。
"""

import logging
import os

os.environ['ANONYMIZED_TELEMETRY'] = 'False'
os.environ['CHROMA_TELEMETRY_ENABLED'] = 'False'

BACKEND_FASTAPI_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BACKEND_FASTAPI_DIR, '..'))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from lifespan import lifespan
from middleware.error_handler import register_exception_handlers
from middleware.logging import LoggingMiddleware

from api.v1 import router as api_v1_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DEFAULT_CORS_ORIGINS = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:8081',
    'http://127.0.0.1:8081',
]

DEFAULT_UPLOAD_FOLDER = os.path.join(BACKEND_FASTAPI_DIR, 'uploads')
DEFAULT_FRONTEND_DIST = os.path.join(PROJECT_ROOT, 'frontend-client', 'dist')


def _parse_csv_env(name: str, default: list) -> list:
    raw_value = os.environ.get(name, '').strip()
    if not raw_value:
        return list(default)
    return [item.strip() for item in raw_value.split(',') if item.strip()]


def create_app() -> FastAPI:
    app = FastAPI(
        title='RAGSystem Agent API',
        description='智能体系统 API - FastAPI 版',
        version='2.0.0',
        lifespan=lifespan,
    )

    # CORS 中间件
    cors_origins = _parse_csv_env('CORS_ORIGINS', DEFAULT_CORS_ORIGINS)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allow_headers=['Content-Type', 'Authorization', 'X-Request-ID'],
    )

    # 日志中间件
    app.add_middleware(LoggingMiddleware)

    # 注册异常处理器
    register_exception_handlers(app)

    # 注册 API 路由
    app.include_router(api_v1_router, prefix='/api')

    # 静态文件服务（上传文件）
    upload_folder = os.environ.get('UPLOAD_FOLDER', DEFAULT_UPLOAD_FOLDER)
    os.makedirs(upload_folder, exist_ok=True)
    if os.path.exists(upload_folder):
        app.mount('/uploads', StaticFiles(directory=upload_folder), name='uploads')

    # 前端静态文件服务
    frontend_dist = os.environ.get('FRONTEND_DIST', DEFAULT_FRONTEND_DIST)
    if os.path.exists(frontend_dist):
        app.mount('/assets', StaticFiles(directory=os.path.join(frontend_dist, 'assets')), name='assets')

        @app.get('/')
        async def frontend_index():
            index_path = os.path.join(frontend_dist, 'index.html')
            if os.path.exists(index_path):
                return FileResponse(index_path)
            return JSONResponse({'message': '前端文件未找到'}, status_code=404)

        @app.get('/{full_path:path}')
        async def frontend_static(full_path: str):
            file_path = os.path.join(frontend_dist, full_path)
            if os.path.exists(file_path) and os.path.isfile(file_path):
                return FileResponse(file_path)
            index_path = os.path.join(frontend_dist, 'index.html')
            if os.path.exists(index_path):
                return FileResponse(index_path)
            return JSONResponse({'message': '文件未找到'}, status_code=404)

    return app


app = create_app()

if __name__ == '__main__':
    import uvicorn

    port = int(os.environ.get('PORT', os.environ.get('FASTAPI_PORT', 5001)))
    host = os.environ.get('FASTAPI_HOST', '0.0.0.0')
    reload = os.environ.get('FASTAPI_RELOAD', 'true').lower() == 'true'

    uvicorn.run(
        'main:app',
        host=host,
        port=port,
        reload=reload,
        reload_dirs=[BACKEND_FASTAPI_DIR],
    )
