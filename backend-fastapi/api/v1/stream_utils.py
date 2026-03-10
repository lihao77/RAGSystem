# -*- coding: utf-8 -*-
"""
流式 API 工具函数。
"""

import asyncio
import threading
from typing import AsyncGenerator, Callable, Iterator


async def sync_to_async_sse(
    sync_stream: Callable[[], Iterator[str]],
    session_id: str,
    cleanup_callback: Callable[[], None] = None,
) -> AsyncGenerator[str, None]:
    """
    将同步 SSE 流转换为异步生成器。

    参数:
        sync_stream: 返回同步迭代器的可调用对象
        session_id: 会话 ID (用于错误消息)
        cleanup_callback: 可选的清理回调函数,在流结束后调用

    生成:
        SSE 数据行 (已格式化为 "data: {json}\\n\\n")
    """
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def _run_sync_stream():
        try:
            for sse_data in sync_stream():
                loop.call_soon_threadsafe(queue.put_nowait, ('data', sse_data))
        except Exception as e:
            loop.call_soon_threadsafe(queue.put_nowait, ('error', str(e)))
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, ('done', None))
            if cleanup_callback:
                try:
                    cleanup_callback()
                except Exception:
                    pass

    threading.Thread(target=_run_sync_stream, daemon=True).start()

    while True:
        kind, value = await queue.get()
        if kind == 'done':
            break
        elif kind == 'error':
            import json
            yield f"data: {json.dumps({'type': 'error', 'content': value, 'session_id': session_id}, ensure_ascii=False)}\n\n"
            break
        else:
            # value 已经是 "data: {json}\n\n" 格式，直接透传
            yield value
