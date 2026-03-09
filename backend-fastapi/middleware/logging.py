# -*- coding: utf-8 -*-
"""
请求日志中间件。
"""

import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger(__name__)


class LoggingMiddleware(BaseHTTPMiddleware):
    """记录每次请求的方法、路径、状态码和耗时。"""

    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get('X-Request-ID', str(uuid.uuid4())[:8])
        start_time = time.perf_counter()

        # 跳过静态资源的日志
        path = request.url.path
        if path.startswith(('/uploads/', '/assets/', '/favicon')):
            return await call_next(request)

        logger.info('[%s] %s %s', request_id, request.method, path)

        try:
            response = await call_next(request)
            elapsed = (time.perf_counter() - start_time) * 1000
            logger.info(
                '[%s] %s %s -> %d (%.1fms)',
                request_id, request.method, path, response.status_code, elapsed,
            )
            response.headers['X-Request-ID'] = request_id
            return response
        except Exception as exc:
            elapsed = (time.perf_counter() - start_time) * 1000
            logger.error(
                '[%s] %s %s -> ERROR (%.1fms): %s',
                request_id, request.method, path, elapsed, exc,
                exc_info=True,
            )
            raise
