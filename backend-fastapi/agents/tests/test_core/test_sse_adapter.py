# -*- coding: utf-8 -*-
import asyncio
import json
import logging
from queue import Empty

from agents.events.bus import Event, EventBus, EventPriority, EventType
from agents.events.sse_adapter import SSEAdapter, event_to_client_dict, is_critical_event_type


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


def test_sse_adapter_handles_string_terminal_event_type():
    adapter = SSEAdapter(EventBus(), session_id='session-1', buffer_size=2)
    adapter._handle_event(Event(
        type='run.end',
        data={'run_id': 'run-1'},
        session_id='session-1',
    ))

    stream = adapter.stream_sync()
    first_message = next(stream)

    try:
        next(stream)
        raise AssertionError('expected terminal event to stop the stream')
    except StopIteration:
        pass

    payload = json.loads(first_message.removeprefix('data: ').strip())
    assert payload['type'] == 'run.end'
    assert adapter.completed_normally is True
    assert adapter.terminal_event_type == 'run.end'


def test_sse_adapter_preserves_critical_tool_events_under_backpressure():
    adapter = SSEAdapter(EventBus(), session_id='session-1', buffer_size=1)

    adapter._handle_event(Event(
        type=EventType.CHUNK,
        data={'content': 'partial'},
        session_id='session-1',
    ))
    adapter._handle_event(Event(
        type='call.tool.start',
        data={'tool_name': 'search'},
        session_id='session-1',
    ))

    item = adapter._event_queue.get_nowait()

    assert item.type == 'call.tool.start'
    assert adapter._dropped_count == 1

    try:
        adapter._event_queue.get_nowait()
        raise AssertionError('expected queue to contain only the critical event')
    except Empty:
        pass


def test_event_bus_subscription_log_is_summarized_for_many_event_types(caplog):
    bus = EventBus()
    caplog.set_level(logging.DEBUG)

    bus.subscribe(event_types=list(EventType), handler=lambda event: None)

    assert 'total=' in caplog.text
    assert 'run.start' in caplog.text
    assert 'daemon.adapter.status' not in caplog.text
