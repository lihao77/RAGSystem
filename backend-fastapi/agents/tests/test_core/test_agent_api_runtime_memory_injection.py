# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents import AgentContext
from core.path_resolution import get_session_workspace_root, get_workspace_memory_key
from services.agent_api_runtime_service import AgentApiRuntimeService


class _FakeConversationStore:
    def get_session(self, session_id):
        return {
            'metadata': {
                'workspace_root': 'E:/Python/RAGSystem/workspaces/demo-workspace',
                'team': 'alpha-team',
            }
        }

    def get_recent_messages(self, **kwargs):
        return []


class _FakeConversationStoreWithoutExplicitWorkspace:
    def get_session(self, session_id):
        return {
            'metadata': {
                'team': 'alpha-team',
            }
        }

    def get_recent_messages(self, **kwargs):
        return []


def test_build_context_auto_injects_agent_and_workspace_memory_indices(monkeypatch):
    service = AgentApiRuntimeService(
        conversation_store=_FakeConversationStore(),
        config_manager_getter=lambda: SimpleNamespace(
            get_team_configs=lambda team_name: {
                'chart_agent': SimpleNamespace(
                    memory=SimpleNamespace(
                        auto_inject=True,
                        allowed_scopes=['team', 'session', 'agent', 'workspace'],
                        write_scopes=[],
                        archive_scopes=[],
                    )
                )
            },
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    auto_inject=True,
                    allowed_scopes=['team', 'session', 'agent', 'workspace'],
                    write_scopes=[],
                    archive_scopes=[],
                )
            ),
        ),
    )
    calls = []

    def fake_load_index_head(**kwargs):
        calls.append(kwargs)
        scope = kwargs['scope']
        if scope == 'team':
            return '# Team Memory\n'
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
                    allowed_scopes=['team', 'session', 'agent', 'workspace'],
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
        'allowed_scopes': ['team', 'session', 'agent', 'workspace'],
        'write_scopes': [],
        'archive_scopes': [],
    }
    assert context.metadata['memory_indices'] == {
        'team': '# Team Memory\n',
        'session': '# Session Memory\n',
        'agent': '# Agent Memory\n',
        'workspace': '# Workspace Memory\n',
    }
    assert {'scope': 'team', 'team_name': 'alpha-team'} in calls
    assert {'scope': 'agent', 'agent_name': 'chart_agent', 'team_name': 'alpha-team'} in calls
    assert {'scope': 'workspace', 'workspace_key': 'E-Python-RAGSystem-workspaces-demo-workspace'} in calls


def test_build_context_memory_query_includes_agent_and_workspace_scope_chain(monkeypatch):
    service = AgentApiRuntimeService(
        conversation_store=_FakeConversationStore(),
        config_manager_getter=lambda: SimpleNamespace(
            get_team_configs=lambda team_name: {
                'chart_agent': SimpleNamespace(
                    memory=SimpleNamespace(
                        auto_inject=True,
                        allowed_scopes=['team', 'session', 'agent', 'workspace'],
                        write_scopes=[],
                        archive_scopes=[],
                    )
                )
            },
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    auto_inject=True,
                    allowed_scopes=['team', 'session', 'agent', 'workspace'],
                    write_scopes=[],
                    archive_scopes=[],
                )
            ),
        ),
    )
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
                    allowed_scopes=['team', 'session', 'agent', 'workspace'],
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
        {'scope': 'team', 'team_name': 'alpha-team'},
        {'scope': 'session', 'session_id': 'session-1'},
        {'scope': 'agent', 'agent_name': 'chart_agent', 'team_name': 'alpha-team'},
        {'scope': 'workspace', 'workspace_key': 'E-Python-RAGSystem-workspaces-demo-workspace'},
    ]


def test_build_context_uses_default_session_workspace_for_memory(monkeypatch):
    service = AgentApiRuntimeService(
        conversation_store=_FakeConversationStoreWithoutExplicitWorkspace(),
        config_manager_getter=lambda: SimpleNamespace(
            get_team_configs=lambda team_name: {
                'chart_agent': SimpleNamespace(
                    memory=SimpleNamespace(
                        auto_inject=True,
                        allowed_scopes=['team', 'session', 'agent', 'workspace'],
                        write_scopes=[],
                        archive_scopes=[],
                    )
                )
            },
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    auto_inject=True,
                    allowed_scopes=['team', 'session', 'agent', 'workspace'],
                    write_scopes=[],
                    archive_scopes=[],
                )
            ),
        ),
    )
    captured = []

    service._memory_store = SimpleNamespace(
        load_index_head=lambda **kwargs: captured.append(kwargs) or '# Workspace Memory\n',
        search_memories=lambda **kwargs: [],
    )

    monkeypatch.setattr(
        'services.agent_api_runtime_service.get_config_manager',
        lambda: SimpleNamespace(
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    auto_inject=True,
                    allowed_scopes=['team', 'session', 'agent', 'workspace'],
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

    assert context.metadata['workspace_root'].endswith('/sessions/session-1/workspace') or context.metadata['workspace_root'].endswith('\\sessions\\session-1\\workspace')
    assert {'scope': 'workspace', 'workspace_key': get_workspace_memory_key(context.metadata['workspace_root'])} in captured
