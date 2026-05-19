# -*- coding: utf-8 -*-
"""Client-facing event helpers shared by realtime transports."""

from typing import Optional

from .bus import CRITICAL_EVENT_TYPES, Event, EventType


def event_type_value(event_type: str | EventType) -> str:
    return event_type.value if hasattr(event_type, "value") else str(event_type)


_CRITICAL_EVENT_VALUES: frozenset[str] = frozenset(event_type_value(e) for e in CRITICAL_EVENT_TYPES)


def is_critical_event_type(event_type: str | EventType) -> bool:
    """Accept both raw strings and EventType enums for backpressure protection."""
    if event_type in CRITICAL_EVENT_TYPES:
        return True
    if isinstance(event_type, str):
        return event_type in _CRITICAL_EVENT_VALUES
    return False


def build_client_event_data(event_type: str, data: Optional[dict]) -> dict:
    """Build a client-facing event payload while preserving tool result semantics."""
    payload = dict(data or {})
    if event_type == EventType.CALL_TOOL_END.value:
        preview = payload.get("result_preview")
        if preview is None:
            preview = payload.get("result")
        if preview is not None:
            payload["result_preview"] = preview
            payload["result"] = preview
        if "raw_result_available" not in payload:
            payload["raw_result_available"] = payload.get("raw_result") is not None
    return payload


def event_to_client_dict(event: Event) -> dict:
    """Convert Event to the transport-neutral client payload used by WebSocket."""
    event_type = event_type_value(event.type)
    d = {
        "type": event_type,
        "event_id": event.event_id,
        "timestamp": event.timestamp,
        "priority": event.priority.value if hasattr(event.priority, "value") else event.priority,
        "data": build_client_event_data(event_type, event.data),
        "requires_user_action": event.requires_user_action,
        "seq": event.sequence_number,
    }
    if event.session_id is not None:
        d["session_id"] = event.session_id
    if event.trace_id is not None:
        d["trace_id"] = event.trace_id
    if event.span_id is not None:
        d["span_id"] = event.span_id
    if event.agent_name is not None:
        d["agent_name"] = event.agent_name
    if event.call_id is not None:
        d["call_id"] = event.call_id
    if event.parent_call_id is not None:
        d["parent_call_id"] = event.parent_call_id
    if event.user_action_timeout is not None:
        d["user_action_timeout"] = event.user_action_timeout
    return d
