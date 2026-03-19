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
    cleanup_callback: Callable[..., None] = None,
) -> AsyncGenerator[str, None]:
    """
    将同步 SSE 流转换为异步生成器。

    参数:
        sync_stream: 返回同步迭代器的可调用对象
        session_id: 会话 ID (用于错误消息)
        cleanup_callback: 可选的清理回调函数,在流结束后调用；优先传入 natural_completion 标记

    生成:
        SSE 数据行 (已格式化为 "data: {json}\\n\\n")
    """
    queue: asyncio.Queue = asyncio.Queue()
    stop_event = threading.Event()
    loop = asyncio.get_event_loop()
    natural_completion = False

    def _safe_enqueue(item):
        """向异步队列投递，忽略 loop 已关闭的情况。"""
        try:
            loop.call_soon_threadsafe(queue.put_nowait, item)
        except RuntimeError:
            pass  # event loop 已关闭，无需投递

    def _run_sync_stream():
        nonlocal natural_completion
        gen = sync_stream()
        try:
            for sse_data in gen:
                if stop_event.is_set():
                    break
                _safe_enqueue(('data', sse_data))
            else:
                natural_completion = True
        except Exception as e:
            _safe_enqueue(('error', str(e)))
        finally:
            gen.close()
            _safe_enqueue(('done', None))
            if cleanup_callback:
                try:
                    cleanup_callback(natural_completion=natural_completion)
                except TypeError:
                    try:
                        cleanup_callback()
                    except Exception:
                        pass
                except Exception:
                    pass

    threading.Thread(target=_run_sync_stream, daemon=True).start()

    try:
        while True:
            kind, value = await queue.get()
            if kind == 'done':
                break
            elif kind == 'error':
                import json
                yield f"data: {json.dumps({'type': 'error', 'content': value, 'session_id': session_id}, ensure_ascii=False)}\n\n"
                break
            else:
                yield value
    finally:
        stop_event.set()
