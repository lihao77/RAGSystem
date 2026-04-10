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
                        enabled=True,
                        auto_inject=True,
                        allowed_scopes=['team', 'session', 'agent', 'workspace'],
                        write_scopes=[],
                        archive_scopes=[],
                    )
                )
            },
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    enabled=True,
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
                    enabled=True,
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
    )

    assert context.memory_prefix_handle is not None
    assert context.metadata['memory_prefix_snapshot']['scope_capabilities'] == {
        'allowed_scopes': ['team', 'session', 'agent', 'workspace'],
        'write_scopes': [],
        'archive_scopes': [],
    }
    assert context.metadata['memory_prefix_snapshot']['indices'] == {
        'team': '# Team Memory\n',
        'session': '# Session Memory\n',
        'agent': '# Agent Memory\n',
        'workspace': '# Workspace Memory\n',
    }
    assert context.metadata['memory_prefix_snapshot']['rendered_block']
    assert context.metadata['memory_prefix_snapshot']['baseline_key'] == 'root::chart_agent'
    assert {'scope': 'team', 'team_name': 'alpha-team'} in calls
    assert {'scope': 'agent', 'agent_name': 'chart_agent', 'team_name': 'alpha-team'} in calls
    assert {'scope': 'workspace', 'workspace_key': 'E-Python-RAGSystem-workspaces-demo-workspace'} in calls


def test_build_context_does_not_auto_retrieve_memory_files(monkeypatch):
    service = AgentApiRuntimeService(
        conversation_store=_FakeConversationStore(),
        config_manager_getter=lambda: SimpleNamespace(
            get_team_configs=lambda team_name: {
                'chart_agent': SimpleNamespace(
                    memory=SimpleNamespace(
                        enabled=True,
                        auto_inject=True,
                        allowed_scopes=['team', 'session', 'agent', 'workspace'],
                        write_scopes=[],
                        archive_scopes=[],
                    )
                )
            },
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    enabled=True,
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
                    enabled=True,
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
    )

    assert captured == {}
    assert 'retrieved_memories' not in context.metadata
    assert context.metadata['memory_prefix_snapshot']['indices'] == {}


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
    )



def test_build_context_reuses_persisted_memory_prefix_state(monkeypatch):
    service = AgentApiRuntimeService(
        conversation_store=_FakeConversationStore(),
        config_manager_getter=lambda: SimpleNamespace(
            get_team_configs=lambda team_name: {
                'chart_agent': SimpleNamespace(
                    memory=SimpleNamespace(
                        enabled=True,
                        auto_inject=True,
                        allowed_scopes=['team', 'session'],
                        write_scopes=[],
                        archive_scopes=[],
                    )
                )
            },
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    enabled=True,
                    auto_inject=True,
                    allowed_scopes=['team', 'session'],
                    write_scopes=[],
                    archive_scopes=[],
                )
            ),
        ),
    )
    seed_fingerprint = service._build_memory_prefix_fingerprint(
        memory_config=SimpleNamespace(
            enabled=True,
            auto_inject=True,
            allowed_scopes=['team', 'session'],
            write_scopes=[],
            archive_scopes=[],
        ),
        scope_specs=[
            ('team', {'scope': 'team', 'team_name': 'alpha-team'}),
            ('session', {'scope': 'session', 'session_id': 'session-1'}),
        ],
        agent_name='chart_agent',
    )
    session = {
        'metadata': {
            'team': 'alpha-team',
            'memory_prefix_states': {
                'root::chart_agent': {
                    'baseline_key': 'root::chart_agent',
                    'fingerprint': seed_fingerprint,
                    'scope_capabilities': {
                        'allowed_scopes': ['team', 'session'],
                        'write_scopes': [],
                        'archive_scopes': [],
                    },
                    'indices': {'team': '# Team Memory\n'},
                    'rendered_block': '[Memory Scope Capabilities]\n- 可读取 scope: team, session\n- 可写入 scope: 无\n- 可归档 scope: 无\n- 执行 memory 工具前，必须先确认目标 scope 在对应权限列表内，避免误操作\n\n[Team Memory Index]\n# Team Memory',
                    'rebased_reason': 'seed',
                }
            },
        }
    }

    class _Store(_FakeConversationStore):
        def get_session(self, session_id):
            return session

        def update_session_metadata(self, session_id, metadata_patch, *, merge_nested=False):
            raise AssertionError('should reuse existing snapshot without persistence')

    service = AgentApiRuntimeService(
        conversation_store=_Store(),
        config_manager_getter=lambda: SimpleNamespace(
            get_team_configs=lambda team_name: {
                'chart_agent': SimpleNamespace(
                    memory=SimpleNamespace(
                        enabled=True,
                        auto_inject=True,
                        allowed_scopes=['team', 'session'],
                        write_scopes=[],
                        archive_scopes=[],
                    )
                )
            },
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    enabled=True,
                    auto_inject=True,
                    allowed_scopes=['team', 'session'],
                    write_scopes=[],
                    archive_scopes=[],
                )
            ),
        ),
    )
    service._memory_store = SimpleNamespace(
        load_index_head=lambda **kwargs: (_ for _ in ()).throw(AssertionError('should not rebuild indices')),
        search_memories=lambda **kwargs: [],
    )

    monkeypatch.setattr(
        'services.agent_api_runtime_service.get_config_manager',
        lambda: SimpleNamespace(
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    enabled=True,
                    auto_inject=True,
                    allowed_scopes=['team', 'session'],
                    write_scopes=[],
                    archive_scopes=[],
                )
            )
        ),
    )

    context = service.build_context(session_id='session-1', agent_name='chart_agent')

    assert context.metadata['memory_prefix_snapshot']['fingerprint']['fingerprint'] == seed_fingerprint['fingerprint']
    assert context.metadata['memory_prefix_snapshot']['rebased_reason'] == 'seed'


def test_build_context_rebuilds_memory_prefix_when_memory_config_changes(monkeypatch):
    class _Store(_FakeConversationStore):
        def __init__(self):
            self.metadata_updates = []

        def get_session(self, session_id):
            return {
                'metadata': {
                    'team': 'alpha-team',
                    'memory_prefix_states': {
                        'root::chart_agent': {
                            'baseline_key': 'root::chart_agent',
                            'fingerprint': {'fingerprint': 'old-fingerprint'},
                            'scope_capabilities': {'allowed_scopes': ['team'], 'write_scopes': [], 'archive_scopes': []},
                            'indices': {'team': '# Old Team Memory\n'},
                            'rendered_block': '[Team Memory Index]\n# Old Team Memory',
                            'rebased_reason': 'seed',
                        }
                    },
                }
            }

        def update_session_metadata(self, session_id, metadata_patch, *, merge_nested=False):
            self.metadata_updates.append((session_id, metadata_patch, merge_nested))
            return {'memory_prefix_states': metadata_patch['memory_prefix_states']}

    store = _Store()
    service = AgentApiRuntimeService(
        conversation_store=store,
        config_manager_getter=lambda: SimpleNamespace(
            get_team_configs=lambda team_name: {
                'chart_agent': SimpleNamespace(
                    memory=SimpleNamespace(
                        enabled=True,
                        auto_inject=True,
                        allowed_scopes=['team', 'session'],
                        write_scopes=['session'],
                        archive_scopes=[],
                    )
                )
            },
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    enabled=True,
                    auto_inject=True,
                    allowed_scopes=['team', 'session'],
                    write_scopes=['session'],
                    archive_scopes=[],
                )
            ),
        ),
    )
    service._memory_store = SimpleNamespace(
        load_index_head=lambda **kwargs: '# New Memory\n',
        search_memories=lambda **kwargs: [],
    )

    monkeypatch.setattr(
        'services.agent_api_runtime_service.get_config_manager',
        lambda: SimpleNamespace(
            get_config=lambda name: SimpleNamespace(
                memory=SimpleNamespace(
                    enabled=True,
                    auto_inject=True,
                    allowed_scopes=['team', 'session'],
                    write_scopes=['session'],
                    archive_scopes=[],
                )
            )
        ),
    )

    context = service.build_context(session_id='session-1', agent_name='chart_agent')

    assert store.metadata_updates
    assert context.metadata['memory_prefix_snapshot']['fingerprint']['fingerprint'] != 'old-fingerprint'
    assert context.metadata['memory_prefix_snapshot']['rebased_reason'] == 'build_context'
