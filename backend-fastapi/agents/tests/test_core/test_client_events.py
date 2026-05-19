# -*- coding: utf-8 -*-

from agents.events.bus import Event, EventPriority, EventType
from agents.events.client_events import event_to_client_dict, is_critical_event_type


def test_is_critical_event_type_accepts_enum_and_string():
    assert is_critical_event_type(EventType.CALL_TOOL_START) is True
    assert is_critical_event_type(EventType.CALL_TOOL_START.value) is True
    assert is_critical_event_type(EventType.CHUNK) is False
    assert is_critical_event_type(EventType.LLM_FIRST_TOKEN) is True
    assert is_critical_event_type(EventType.EXECUTION_WAITING_START) is True
    assert is_critical_event_type(EventType.EXECUTION_WAITING_END) is True
    assert is_critical_event_type(EventType.EXECUTION_WAITING_TIMEOUT) is True


def test_event_to_client_dict_preserves_compatible_fields_and_omits_none():
    payload = event_to_client_dict(Event(
        type='custom.event',
        data={},
        priority=EventPriority.NORMAL,
        requires_user_action=False,
    ))

    assert payload['type'] == 'custom.event'
    assert payload['priority'] == EventPriority.NORMAL.value
    assert payload['data'] == {}
    assert payload['requires_user_action'] is False
    assert 'seq' in payload
    assert 'session_id' not in payload
    assert 'trace_id' not in payload
    assert 'user_action_timeout' not in payload
