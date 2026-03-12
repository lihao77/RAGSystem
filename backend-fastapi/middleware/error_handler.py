# -*- coding: utf-8 -*-
"""
错误处理中间件。
"""

import logging

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)


def register_exception_handlers(app: FastAPI) -> None:
    """注册全局异常处理器。"""

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        if exc.status_code == 404:
            detail = str(exc.detail or '').strip()
            if detail and detail.lower() != 'not found':
                return JSONResponse(
                    status_code=404,
                    content={'success': False, 'message': detail},
                )
            return JSONResponse(
                status_code=404,
                content={'success': False, 'message': '接口不存在'},
            )
        return JSONResponse(
            status_code=exc.status_code,
            content={'success': False, 'message': str(exc.detail)},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        messages = []
        for error in errors:
            loc = ' -> '.join(str(x) for x in error.get('loc', []))
            msg = error.get('msg', '')
            messages.append(f'{loc}: {msg}' if loc else msg)

        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                'success': False,
                'message': '请求参数验证失败',
                'details': messages,
            },
        )

    @app.exception_handler(Exception)
    async def generic_exception_handler(request: Request, exc: Exception):
        logger.error('未处理的异常: %s %s -> %s', request.method, request.url, exc, exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={'success': False, 'message': '服务器内部错误'},
        )
