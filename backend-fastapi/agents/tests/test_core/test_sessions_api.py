# -*- coding: utf-8 -*-
import pytest

pytest.importorskip('fastapi')
pytest.importorskip('fastapi.testclient')


class _FakeSessionApp:
    def __init__(self):
        self.list_messages_calls = []
        self.list_message_run_steps_calls = []

    def list_messages(self, *, session_id: str, limit: int, offset: int, expand_steps: bool = False):
        self.list_messages_calls.append({
            'session_id': session_id,
            'limit': limit,
            'offset': offset,
            'expand_steps': expand_steps,
        })
        return {
            'items': [
                {
                    'id': 'msg-final',
                    'role': 'assistant',
                    'content': '最终答案',
                    'metadata': {'run_id': 'run-1'},
                    'has_execution': True,
                }
            ],
            'total': 1,
            'limit': limit,
            'offset': offset,
            'has_more': False,
        }

    def list_message_run_steps(self, *, session_id: str, message_id: str, limit: int, offset: int):
        self.list_message_run_steps_calls.append({
            'session_id': session_id,
            'message_id': message_id,
            'limit': limit,
            'offset': offset,
        })
        return {
            'items': [{'kind': 'run', 'phase': 'start', 'call_id': 'root-call'}],
            'total': 1,
            'limit': limit,
            'offset': offset,
            'has_more': False,
        }


class _FakeRuntimeService:
    def __init__(self, session_app):
        self._session_app = session_app

    def get_session_application(self):
        return self._session_app

    def get_collaboration_application(self):
        raise AssertionError('unexpected collaboration app access')


def _build_client(monkeypatch):
    fastapi = pytest.importorskip('fastapi')
    testclient_mod = pytest.importorskip('fastapi.testclient')
    FastAPI = fastapi.FastAPI
    TestClient = testclient_mod.TestClient

    from api.v1.sessions import router as sessions_router
    import dependencies

    session_app = _FakeSessionApp()
    runtime_service = _FakeRuntimeService(session_app)
    monkeypatch.setattr(dependencies, 'get_agent_runtime_service', lambda: runtime_service)

    app = FastAPI()
    app.include_router(sessions_router, prefix='/api/agent')
    return TestClient(app), session_app


def test_get_session_messages_defaults_to_lazy_run_steps(monkeypatch):
    client, session_app = _build_client(monkeypatch)

    response = client.get('/api/agent/sessions/session-1/messages?limit=50&offset=5')

    assert response.status_code == 200
    assert response.json()['data']['items'][0]['has_execution'] is True
    assert session_app.list_messages_calls == [{
        'session_id': 'session-1',
        'limit': 50,
        'offset': 5,
        'expand_steps': False,
    }]


def test_get_session_messages_supports_expanded_steps_query(monkeypatch):
    client, session_app = _build_client(monkeypatch)

    response = client.get('/api/agent/sessions/session-1/messages?expand=steps')

    assert response.status_code == 200
    assert session_app.list_messages_calls[0]['expand_steps'] is True


def test_get_session_message_run_steps(monkeypatch):
    client, session_app = _build_client(monkeypatch)

    response = client.get('/api/agent/sessions/session-1/messages/msg-final/run-steps?limit=200&offset=10')

    assert response.status_code == 200
    payload = response.json()['data']
    assert payload['items'][0]['kind'] == 'run'
    assert session_app.list_message_run_steps_calls == [{
        'session_id': 'session-1',
        'message_id': 'msg-final',
        'limit': 200,
        'offset': 10,
    }]
