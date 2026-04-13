# -*- coding: utf-8 -*-
"""守护子系统公共工具函数。"""

from __future__ import annotations

import json
from enum import Enum
from typing import Optional


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
    """同步消费 SSE 事件流，返回 final_answer 内容。"""
    final_answer = None
    for sse_line in sse_adapter.stream_sync():
        try:
            if not sse_line.startswith('data: '):
                continue
            event = json.loads(sse_line[6:].strip())
            if event.get('type') == 'final_answer':
                final_answer = (event.get('data') or {}).get('content')
        except Exception:
            pass
    return final_answer
