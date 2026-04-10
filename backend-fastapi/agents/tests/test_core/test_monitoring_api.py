# -*- coding: utf-8 -*-
from types import SimpleNamespace

import pytest

pytest.importorskip('fastapi')
pytest.importorskip('fastapi.testclient')


class _FakeContextPipeline:
    config = SimpleNamespace(
        compression_trigger_ratio=0.8,
        preserve_recent_turns=6,
        summarize_max_tokens=1024,
    )

    def inspect_messages_with_stats(self, system_prompt, context):
        return SimpleNamespace(
            messages=[
                {'role': 'system', 'content': system_prompt},
                {
                    'seq': 1,
                    'role': 'system',
                    'content': 'S' * 300,
                    'metadata': {},
                },
                {
                    'seq': 2,
                    'role': 'user',
                    'content': 'U' * 300,
                    'metadata': {},
                },
            ],
            system_tokens=10,
            total_tokens=40,
            budget_tokens=100,
        )

    def count_messages_tokens(self, messages):
        return sum(len((msg or {}).get('content', '')) for msg in messages)


class _FakeAgent:
    name = 'orchestrator_agent'
    display_name = 'Orchestrator Agent'
    max_rounds = 8
    context_pipeline = _FakeContextPipeline()
    available_tools = []
    available_skills = []

    def _build_system_prompt(self):
        return 'base system prompt'

    def get_llm_config(self, context=None):
        return {'model_name': 'test-model'}


class _FakeOrchestrator:
    def resolve_default_entry_agent(self):
        return _FakeAgent()


class _FakeRuntimeService:
    def get_orchestrator(self):
        return _FakeOrchestrator()

    def create_execution_orchestrator(self, session_id=None):
        return _FakeOrchestrator()

    def build_context(self, session_id=None, agent_name=None):
        return SimpleNamespace(session_id=session_id, agent_name=agent_name)


def _build_client(monkeypatch):
    fastapi = pytest.importorskip('fastapi')
    testclient_mod = pytest.importorskip('fastapi.testclient')
    FastAPI = fastapi.FastAPI
    TestClient = testclient_mod.TestClient

    import dependencies
    from api.v1.monitoring import router as monitoring_router

    monkeypatch.setattr(dependencies, 'get_agent_runtime_service', lambda: _FakeRuntimeService())

    app = FastAPI()
    app.include_router(monitoring_router, prefix='/api/agent')
    return TestClient(app)


def test_context_snapshot_returns_full_system_message_preview(monkeypatch):
    client = _build_client(monkeypatch)

    response = client.get('/api/agent/context-snapshot', params={'session_id': 'session-1'})

    assert response.status_code == 200
    history = response.json()['data']['conversation_history']
    system_msg = history[0]
    user_msg = history[1]

    assert system_msg['role'] == 'system'
    assert system_msg['content_preview'] == 'S' * 300
    assert system_msg['is_preview_truncated'] is False
    assert system_msg['can_load_full_content'] is False

    assert user_msg['role'] == 'user'
    assert user_msg['content_preview'] == ('U' * 200) + '...'
    assert user_msg['is_preview_truncated'] is True
    assert user_msg['can_load_full_content'] is True
