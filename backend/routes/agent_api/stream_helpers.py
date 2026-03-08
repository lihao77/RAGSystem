# -*- coding: utf-8 -*-
"""
Agent 流式执行辅助函数。
"""

from typing import Any, Callable, Dict, Optional

from execution.observability import apply_observability_fields

from .shared import json


def parse_selected_llm(selected_llm: str) -> Optional[Dict[str, Optional[str]]]:
    selected_llm = (selected_llm or '').strip()
    if not selected_llm:
        return None

    parts = selected_llm.split('|')
    if len(parts) >= 3:
        return {'provider': parts[0], 'provider_type': parts[1], 'model_name': parts[2]}
    if len(parts) == 2:
        return {'provider': parts[0], 'provider_type': '', 'model_name': parts[1]}
    if len(parts) == 1 and parts[0]:
        return {'provider': parts[0], 'provider_type': None, 'model_name': None}
    return None


def format_event_to_sse(event) -> str:
    full_event = {
        'type': event.type.value,
        'event_id': getattr(event, 'event_id', None),
        'timestamp': getattr(event, 'timestamp', None),
        'priority': getattr(getattr(event, 'priority', None), 'value', None),
        'session_id': getattr(event, 'session_id', None),
        'trace_id': getattr(event, 'trace_id', None),
        'span_id': getattr(event, 'span_id', None),
        'agent_name': getattr(event, 'agent_name', None),
        'call_id': getattr(event, 'call_id', None),
        'parent_call_id': getattr(event, 'parent_call_id', None),
        'data': event.data or {},
        'requires_user_action': getattr(event, 'requires_user_action', False),
        'user_action_timeout': getattr(event, 'user_action_timeout', None),
    }
    apply_observability_fields(full_event, event.data or {})
    json_data = json.dumps(full_event, ensure_ascii=False, default=str)
    return f"data: {json_data}\n\n"


def build_stream_response(generate: Callable[[], Any], response_class, stream_with_context_func):
    response = response_class(stream_with_context_func(generate()), mimetype='text/event-stream')
    response.headers['Content-Type'] = 'text/event-stream; charset=utf-8'
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['X-Accel-Buffering'] = 'no'
    return response
