# -*- coding: utf-8 -*-
"""守护子系统公共工具函数。"""

from __future__ import annotations

import json
import logging
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)


def model_validate(model_cls, data):
    """兼容 Pydantic v1/v2 的模型校验。"""
    if hasattr(model_cls, 'model_validate'):
        return model_cls.model_validate(data)
    return model_cls.parse_obj(data)


def model_dump(model, **kwargs):
    """兼容 Pydantic v1/v2 的模型导出。"""
    if hasattr(model, 'model_dump'):
        return model.model_dump(**kwargs)
    return model.dict(**kwargs)


def json_safe(value):
    """递归将枚举等非 JSON 原生类型转为可序列化值。"""
    if isinstance(value, dict):
        return {
            (k.value if isinstance(k, Enum) else k): json_safe(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [json_safe(item) for item in value]
    if isinstance(value, Enum):
        return value.value
    return value


def consume_stream(sse_adapter) -> Optional[str]:
    """同步消费 SSE 事件流，返回 final_answer 或 system.error。

    DEPRECATED: 仅保留兼容签名。新代码应使用 wait_for_run_end()。
    """
    final_answer = None
    for sse_line in sse_adapter.stream_sync():
        try:
            if not sse_line.startswith('data: '):
                continue
            event = json.loads(sse_line[6:].strip())
            event_type = event.get('type', '')
            if event_type == 'output.final_answer':
                final_answer = (event.get('data') or {}).get('content')
            elif event_type == 'system.error':
                message = (event.get('data') or {}).get('message') or 'unknown error'
                return f'ERROR: {message}'
        except json.JSONDecodeError:
            logger.warning('daemon consume_stream: 非 JSON SSE 行: %s', sse_line[:80])
    return final_answer


def wait_for_run_end(
    event_bus,
    session_id: str,
    timeout: float = 600.0,
) -> Optional[str]:
    """直接订阅 EventBus 等待 run 结束，返回 final_answer 或 error 消息。

    替代 consume_stream(sse_adapter) 的双重序列化路径，
    直接从 Event 对象提取结果，无需 SSE 格式中转。

    Args:
        event_bus: run 级 EventBus 实例
        session_id: 当前会话 ID
        timeout: 最大等待秒数

    Returns:
        final_answer 文本、错误消息、或 None
    """
    import threading as _threading

    done_event = _threading.Event()
    result_holder: list = [None]  # [Optional[str]]

    def _on_event(event):
        if event.session_id and event.session_id != session_id:
            return
        from agents.events.bus import EventType
        if event.type == EventType.FINAL_ANSWER:
            content = (event.data or {}).get('content')
            if content:
                result_holder[0] = content
        elif event.type == EventType.ERROR:
            message = (event.data or {}).get('message') or 'unknown error'
            result_holder[0] = f'ERROR: {message}'
            done_event.set()
        elif event.type in (EventType.RUN_END, EventType.USER_INTERRUPT, EventType.SESSION_END):
            done_event.set()

    from agents.events.bus import EventType
    sub_id = event_bus.subscribe(
        event_types=[
            EventType.FINAL_ANSWER,
            EventType.ERROR,
            EventType.RUN_END,
            EventType.USER_INTERRUPT,
            EventType.SESSION_END,
        ],
        handler=_on_event,
    )
    try:
        done_event.wait(timeout=timeout)
        if not done_event.is_set():
            logger.warning('wait_for_run_end 超时 session=%s', session_id)
        return result_holder[0]
    finally:
        try:
            event_bus.unsubscribe(sub_id)
        except Exception:
            pass
