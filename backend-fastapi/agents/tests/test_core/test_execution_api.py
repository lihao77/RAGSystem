# -*- coding: utf-8 -*-
from types import SimpleNamespace

import pytest

pytest.importorskip('fastapi')
pytest.importorskip('fastapi.testclient')
pytest.importorskip('schemas.execution')

from schemas.execution import ExecuteRequest


class _FakeStore:
    def __init__(self):
        self.sessions = {}

    def get_session(self, session_id):
        return self.sessions.get(session_id)

    def create_session(self, *, session_id, user_id=None):
        session = {'session_id': session_id, 'user_id': user_id, 'metadata': {}}
        self.sessions[session_id] = session
        return session


class _FakeRuntime:
    def __init__(self):
        self.store = _FakeStore()

    def get_conversation_store(self):
        return self.store


class _FakeExecutionService:
    def __init__(self):
        self.calls = []

    def invoke_agent(self, **kwargs):
        self.calls.append(('invoke_agent', kwargs))
        return SimpleNamespace(
            response=SimpleNamespace(
                success=True,
                content='ok',
                agent_name=kwargs['agent_name'],
                execution_time=0.1,
                tool_calls=[],
                metadata={},
            ),
            run_id='run-1',
            thread_key='root',
            child_agent_id=None,
        )

    def invoke_routed_agent(self, **kwargs):
        self.calls.append(('invoke_routed_agent', kwargs))
        return SimpleNamespace(
            response=SimpleNamespace(
                success=True,
                content='ok',
                agent_name='qa_agent',
                execution_time=0.1,
                tool_calls=[],
                metadata={},
            ),
            run_id='run-2',
            thread_key='root',
            child_agent_id=None,
        )


def _build_client(monkeypatch):
    fastapi = pytest.importorskip('fastapi')
    testclient_mod = pytest.importorskip('fastapi.testclient')
    FastAPI = fastapi.FastAPI
    TestClient = testclient_mod.TestClient

    from api.v1.execution import router as execution_router
    import dependencies
    import services.agent_execution_service as agent_exec_module

    runtime = _FakeRuntime()
    execution_service = _FakeExecutionService()

    monkeypatch.setattr(dependencies, 'get_agent_runtime_service', lambda: runtime)
    monkeypatch.setattr(agent_exec_module, 'get_agent_execution_service', lambda: execution_service)

    app = FastAPI()
    app.include_router(execution_router, prefix='/api/agent')
    client = TestClient(app)

    return client, execution_service


def test_execute_without_agent_uses_invoke_routed_agent(monkeypatch):
    client, execution_service = _build_client(monkeypatch)

    response = client.post('/api/agent/execute', json=ExecuteRequest(task='hello', session_id='session-1').model_dump())

    assert response.status_code == 200
    assert execution_service.calls[0][0] == 'invoke_routed_agent'
    assert execution_service.calls[0][1]['preferred_agent'] is None



def test_execute_with_agent_uses_invoke_agent(monkeypatch):
    client, execution_service = _build_client(monkeypatch)

    response = client.post(
        '/api/agent/execute',
        json=ExecuteRequest(task='hello', session_id='session-1', agent='orchestrator_agent').model_dump(),
    )

    assert response.status_code == 200
    assert execution_service.calls[0][0] == 'invoke_agent'
    assert execution_service.calls[0][1]['agent_name'] == 'orchestrator_agent'
