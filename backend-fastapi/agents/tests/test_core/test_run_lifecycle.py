# -*- coding: utf-8 -*-

from agents.events.bus import EventBus, EventType
from execution.cleanup import cleanup_after_run
from execution.run_lifecycle import publish_session_run_started, publish_session_updated


def test_publish_session_run_started_uses_global_event_payload():
    bus = EventBus()
    calls = []

    bus.subscribe([EventType.SESSION_RUN_STARTED], lambda event: calls.append(event))

    publish_session_run_started(
        'session-1',
        'run-1',
        source='test',
        data={'extra': True},
        event_bus=bus,
    )

    assert len(calls) == 1
    event = calls[0]
    assert event.type == EventType.SESSION_RUN_STARTED
    assert event.session_id == 'session-1'
    assert event.data == {'run_id': 'run-1', 'source': 'test', 'extra': True}


def test_publish_session_updated_uses_global_event_payload():
    bus = EventBus()
    calls = []

    bus.subscribe([EventType.SESSION_UPDATED], lambda event: calls.append(event))

    publish_session_updated('session-1', 'run-1', source='test', event_bus=bus)

    assert len(calls) == 1
    event = calls[0]
    assert event.type == EventType.SESSION_UPDATED
    assert event.session_id == 'session-1'
    assert event.data == {'run_id': 'run-1', 'source': 'test'}


def test_cleanup_after_run_targets_exact_run(monkeypatch):
    calls = {'cleanup_run': [], 'flush_session': [], 'cleanup_finished': 0}

    monkeypatch.setattr(
        'agents.events.session_manager.cleanup_run',
        lambda run_id: calls['cleanup_run'].append(run_id),
    )
    monkeypatch.setattr(
        'agents.context.session_cache.flush_session',
        lambda session_id: calls['flush_session'].append(session_id),
    )

    class _ExecutionService:
        def cleanup_finished(self):
            calls['cleanup_finished'] += 1

    class _Container:
        def get_execution_service(self):
            return _ExecutionService()

    monkeypatch.setattr(
        'runtime.container.get_current_runtime_container',
        lambda: _Container(),
    )

    cleanup_after_run('session-1', 'old-run')

    assert calls == {
        'cleanup_run': ['old-run'],
        'flush_session': ['session-1'],
        'cleanup_finished': 1,
    }
