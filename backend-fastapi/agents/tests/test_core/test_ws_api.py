# -*- coding: utf-8 -*-
from types import SimpleNamespace

import pytest

pytest.importorskip('fastapi')
pytest.importorskip('fastapi.testclient')

from fastapi import FastAPI
from fastapi.testclient import TestClient

from agents.events.bus import Event, EventBus, EventType
from api.v1.ws import router as ws_router


class _FakeExecutionService:
    def __init__(self, statuses):
        self._statuses = list(statuses)

    def get_status_by_session(self, session_id):
        if self._statuses:
            return self._statuses.pop(0)
        return None


class _FakeRuntimeService:
    def __init__(self, run_buses):
        self._run_buses = run_buses

    def get_run_event_bus(self, run_id, *, session_id=None):
        return self._run_buses[run_id]


class _FakeContainer:
    def __init__(self, execution_service, runtime_service, global_bus):
        self._execution_service = execution_service
        self._runtime_service = runtime_service
        self._global_bus = global_bus

    def get_execution_service(self):
        return self._execution_service

    def get_agent_api_runtime_service(self):
        return self._runtime_service

    def get_event_bus(self):
        return self._global_bus


class _FakeRegistry:
    def is_approval_pending(self, session_id, approval_id):
        return True

    def is_input_pending(self, session_id, input_id):
        return True


def _build_client(monkeypatch, *, statuses):
    import dependencies
    import runtime.container as runtime_container_module

    global_bus = EventBus(enable_persistence=True, max_history=100)
    run_bus = EventBus(enable_persistence=True, max_history=100)
    execution_service = _FakeExecutionService(statuses)
    runtime_service = _FakeRuntimeService({'run-1': run_bus})
    container = _FakeContainer(execution_service, runtime_service, global_bus)

    monkeypatch.setattr(runtime_container_module, 'get_current_runtime_container', lambda: container)
    monkeypatch.setattr(dependencies, 'get_task_registry', lambda: _FakeRegistry())

    app = FastAPI()
    app.include_router(ws_router, prefix='/api/agent')
    return TestClient(app), global_bus, run_bus


def test_ws_replays_existing_run_history(monkeypatch):
    client, _, run_bus = _build_client(monkeypatch, statuses=[{
        'status': 'running',
        'run_id': 'run-1',
        'started_at': 10,
    }])

    history_event = Event(
        type=EventType.CHUNK,
        data={'content': 'hello'},
        session_id='session-1',
        timestamp=11,
    )
    run_bus.publish(history_event)

    with client.websocket_connect('/api/agent/sessions/session-1/ws') as ws:
        reconnect_start = ws.receive_json()
        replay_event = ws.receive_json()
        reconnect_end = ws.receive_json()

    assert reconnect_start['type'] == 'reconnect_start'
    assert reconnect_start['run_id'] == 'run-1'
    assert replay_event['type'] == 'output.chunk'
    assert replay_event['data']['content'] == 'hello'
    assert reconnect_end['type'] == 'reconnect_end'


def test_ws_receives_live_events_from_run_bus(monkeypatch):
    client, _, run_bus = _build_client(monkeypatch, statuses=[None, {
        'status': 'running',
        'run_id': 'run-1',
        'started_at': 10,
    }])

    with client.websocket_connect('/api/agent/sessions/session-1/ws') as ws:
        run_bus.publish(Event(
            type=EventType.CHUNK,
            data={'content': 'live'},
            session_id='session-1',
            timestamp=11,
        ))

        reconnect_start = ws.receive_json()
        replay_event = ws.receive_json()
        reconnect_end = ws.receive_json()

    assert reconnect_start['type'] == 'reconnect_start'
    assert replay_event['type'] == 'output.chunk'
    assert replay_event['data']['content'] == 'live'
    assert reconnect_end['type'] == 'reconnect_end'


def test_ws_receives_command_result_from_global_bus(monkeypatch):
    client, global_bus, _ = _build_client(monkeypatch, statuses=[None])

    with client.websocket_connect('/api/agent/sessions/session-1/ws') as ws:
        global_bus.publish(Event(
            type=EventType.COMMAND_RESULT,
            data={'command': 'help', 'content': 'ok', 'success': True},
            session_id='session-1',
        ))
        payload = ws.receive_json()

    assert payload['type'] == 'command.result'
    assert payload['data']['command'] == 'help'
    assert payload['data']['content'] == 'ok'


def test_ws_receives_session_run_started_from_global_bus(monkeypatch):
    client, global_bus, _ = _build_client(monkeypatch, statuses=[None])

    with client.websocket_connect('/api/agent/sessions/session-1/ws') as ws:
        global_bus.publish(Event(
            type=EventType.SESSION_RUN_STARTED,
            data={'run_id': 'run-bg-1', 'source': 'system.bg_notification'},
            session_id='session-1',
        ))
        payload = ws.receive_json()

    assert payload['type'] == 'session.run_started'
    assert payload['data']['run_id'] == 'run-bg-1'
    assert payload['data']['source'] == 'system.bg_notification'
