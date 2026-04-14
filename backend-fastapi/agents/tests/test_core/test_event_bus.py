# -*- coding: utf-8 -*-
import asyncio
from unittest.mock import patch

from agents.events.bus import Event, EventBus, EventType


def test_event_bus_unsubscribe_only_removes_target_subscription():
    bus = EventBus()
    calls = []

    sub_all = bus.subscribe(
        event_types=[EventType.RUN_START, EventType.RUN_END],
        handler=lambda event: calls.append(('all', event.type)),
    )
    bus.subscribe(
        event_types=[EventType.RUN_END],
        handler=lambda event: calls.append(('end', event.type)),
    )

    bus.unsubscribe(sub_all)
    bus.publish(Event(type=EventType.RUN_START, data={}))
    bus.publish(Event(type=EventType.RUN_END, data={}))

    assert calls == [('end', EventType.RUN_END)]


def test_event_bus_priority_order_in_sync_publish():
    bus = EventBus()
    calls = []

    bus.subscribe([EventType.RUN_START], lambda event: calls.append('low'), priority=1)
    bus.subscribe([EventType.RUN_START], lambda event: calls.append('high'), priority=10)

    bus.publish(Event(type=EventType.RUN_START, data={}))

    assert calls == ['high', 'low']


async def _async_append(calls, label, event):
    calls.append(label)


def test_event_bus_priority_order_in_async_publish():
    bus = EventBus()
    calls = []

    bus.subscribe([EventType.RUN_START], lambda event: calls.append('low'), priority=1)
    bus.subscribe(
        [EventType.RUN_START],
        lambda event: calls.append('medium'),
        priority=5,
    )

    async def high_handler(event):
        calls.append('high')

    bus.subscribe([EventType.RUN_START], high_handler, priority=10)

    asyncio.run(bus.publish_async(Event(type=EventType.RUN_START, data={})))

    assert calls == ['high', 'medium', 'low']


def test_event_bus_filter_func_blocks_delivery():
    bus = EventBus()
    calls = []

    bus.subscribe(
        [EventType.RUN_START],
        lambda event: calls.append('blocked'),
        filter_func=lambda event: False,
    )
    bus.subscribe(
        [EventType.RUN_START],
        lambda event: calls.append('allowed'),
        filter_func=lambda event: True,
    )

    bus.publish(Event(type=EventType.RUN_START, data={}))

    assert calls == ['allowed']


def test_event_bus_handler_can_publish_nested_event():
    bus = EventBus()
    calls = []

    def publish_nested(event):
        calls.append('outer')
        bus.publish(Event(type=EventType.EXECUTION_STEP, data={'nested': True}))

    bus.subscribe([EventType.RUN_START], publish_nested, priority=10)
    bus.subscribe([EventType.EXECUTION_STEP], lambda event: calls.append(event.data['nested']))

    bus.publish(Event(type=EventType.RUN_START, data={}))

    assert calls == ['outer', True]


def test_event_bus_history_preserves_order_and_limit():
    bus = EventBus(enable_persistence=True, max_history=5)

    for index in range(4):
        bus.publish(Event(type=EventType.RUN_START, data={'index': index}, session_id='session-1'))

    history = bus.get_event_history(session_id='session-1', limit=2)

    assert [event.data['index'] for event in history] == [2, 3]
    assert history[0].sequence_number < history[1].sequence_number


def test_event_bus_deque_auto_evicts_old_events():
    bus = EventBus(enable_persistence=True, max_history=3)

    for index in range(5):
        bus.publish(Event(type=EventType.RUN_START, data={'index': index}, session_id='session-1'))

    history = bus.get_event_history(session_id='session-1', limit=10)

    assert [event.data['index'] for event in history] == [2, 3, 4]


def test_event_bus_publish_async_records_sync_handler_failures(caplog):
    bus = EventBus()

    def broken(event):
        raise RuntimeError('boom')

    bus.subscribe([EventType.RUN_START], broken)

    asyncio.run(bus.publish_async(Event(type=EventType.RUN_START, data={})))

    assert bus.get_stats()['failed_events'] == 1
    assert '事件处理失败' in caplog.text
    assert 'boom' in caplog.text


def test_event_bus_run_end_marks_run_ended():
    bus = EventBus()

    with patch('agents.events.session_manager.get_session_manager') as get_session_manager:
        manager = get_session_manager.return_value
        bus.publish(Event(type=EventType.RUN_END, data={'run_id': 'run-1'}))

    manager.mark_run_ended.assert_called_once_with('run-1')
