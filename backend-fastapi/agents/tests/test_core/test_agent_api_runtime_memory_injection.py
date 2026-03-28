# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents import AgentContext
from services.agent_api_runtime_service import AgentApiRuntimeService


class _FakeConversationStore:
    def get_session(self, session_id):
        return {
            'metadata': {
                'workspace_root': 'E:/Python/RAGSystem/workspaces/demo-workspace'
            }
        }

    def get_recent_messages(self, **kwargs):
        return []


def test_build_context_auto_injects_agent_and_workspace_memory_indices(monkeypatch):
    service = AgentApiRuntimeService(conversation_store=_FakeConversationStore())
    calls = []

    def fake_load_index_head(**kwargs):
        calls.append(kwargs)
        scope = kwargs['scope']
        if scope == 'project':
            return '# Project Memory\n'
        if scope == 'session':
            return '# Session Memory\n'
        if scope == 'agent':
            return '# Agent Memory\n'
        if scope == 'workspace':
            return '# Workspace Memory\n'
        return ''

    service._memory_store = SimpleNamespace(
        load_index_head=fake_load_index_head,
        search_memories=lambda **kwargs: [],
    )

    monkeypatch.setattr(
        'services.agent_api_runtime_service.get_config_manager',
        lambda: SimpleNamespace(
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    auto_inject=True,
                    allowed_scopes=['project', 'session', 'agent', 'workspace'],
                    write_scopes=[],
                    archive_scopes=[],
                )
            )
        ),
    )

    context = service.build_context(
        session_id='session-1',
        agent_name='chart_agent',
        memory_query=None,
    )

    assert context.metadata['memory_scope_capabilities'] == {
        'allowed_scopes': ['project', 'session', 'agent', 'workspace'],
        'write_scopes': [],
        'archive_scopes': [],
    }
    assert context.metadata['memory_indices'] == {
        'project': '# Project Memory\n',
        'session': '# Session Memory\n',
        'agent': '# Agent Memory\n',
        'workspace': '# Workspace Memory\n',
    }
    assert {'scope': 'agent', 'agent_name': 'chart_agent'} in calls
    assert {'scope': 'workspace', 'workspace_key': 'demo-workspace'} in calls


def test_build_context_memory_query_includes_agent_and_workspace_scope_chain(monkeypatch):
    service = AgentApiRuntimeService(conversation_store=_FakeConversationStore())
    captured = {}

    service._memory_store = SimpleNamespace(
        load_index_head=lambda **kwargs: '',
        search_memories=lambda **kwargs: captured.update(kwargs) or [],
    )

    monkeypatch.setattr(
        'services.agent_api_runtime_service.get_config_manager',
        lambda: SimpleNamespace(
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    auto_inject=True,
                    allowed_scopes=['project', 'session', 'agent', 'workspace'],
                    write_scopes=[],
                    archive_scopes=[],
                )
            )
        ),
    )

    service.build_context(
        session_id='session-1',
        agent_name='chart_agent',
        memory_query='flood risk',
    )

    assert captured['query'] == 'flood risk'
    assert captured['scope_chain'] == [
        {'scope': 'project'},
        {'scope': 'session', 'session_id': 'session-1'},
        {'scope': 'agent', 'agent_name': 'chart_agent'},
        {'scope': 'workspace', 'workspace_key': 'demo-workspace'},
    ]
