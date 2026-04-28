# -*- coding: utf-8 -*-
import asyncio
import logging
from queue import Empty

from agents.events.bus import Event, EventBus, EventType
from agents.events.sse_adapter import SSEAdapter, is_critical_event_type


def test_is_critical_event_type_accepts_enum_and_string():
    assert is_critical_event_type(EventType.CALL_TOOL_START) is True
    assert is_critical_event_type(EventType.CALL_TOOL_START.value) is True
    assert is_critical_event_type(EventType.CHUNK) is False
    assert is_critical_event_type(EventType.LLM_FIRST_TOKEN) is True
    assert is_critical_event_type(EventType.EXECUTION_WAITING_START) is True
    assert is_critical_event_type(EventType.EXECUTION_WAITING_END) is True
    assert is_critical_event_type(EventType.EXECUTION_WAITING_TIMEOUT) is True


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
