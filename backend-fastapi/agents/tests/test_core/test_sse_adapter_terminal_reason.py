# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.events.bus import EventType
from agents.events.sse_adapter import SSEAdapter


class _FakeEventBus:
    def __init__(self):
        self.unsubscribe_calls = []

    def subscribe(self, event_types, handler, filter_func=None, priority=0):
        return 'sub-1'

    def unsubscribe(self, subscription_id):
        self.unsubscribe_calls.append(subscription_id)
        return None


def _event(event_type, *, agent_name='orchestrator_agent', parent_call_id=None):
    return SimpleNamespace(
        type=event_type,
        agent_name=agent_name,
        parent_call_id=parent_call_id,
        session_id='session-1',
        data={},
    )


def test_sse_adapter_does_not_stop_on_top_level_call_agent_end():
    adapter = SSEAdapter(event_bus=_FakeEventBus(), session_id='session-1')

    assert adapter._terminal_reason(_event(EventType.CALL_AGENT_START, parent_call_id=None)) is None
    assert adapter._terminal_reason(_event(EventType.CALL_AGENT_END, parent_call_id=None)) is None
    assert adapter._terminal_reason(_event(EventType.AGENT_END, parent_call_id=None)) is None


def test_sse_adapter_stops_on_run_end():
    adapter = SSEAdapter(event_bus=_FakeEventBus(), session_id='session-1')

    assert adapter._terminal_reason(_event(EventType.RUN_END)) == EventType.RUN_END.value


def test_sse_adapter_stop_is_idempotent():
    event_bus = _FakeEventBus()
    adapter = SSEAdapter(event_bus=event_bus, session_id='session-1')
    adapter._subscription_id = 'sub-1'

    adapter.stop()
    adapter.stop()

    assert adapter._stopped is True
    assert event_bus.unsubscribe_calls == ['sub-1']
