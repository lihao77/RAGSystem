# -*- coding: utf-8 -*-
from __future__ import annotations

import importlib
import sys
from types import SimpleNamespace

import pytest

from agents.config.loader import AgentLoader
from agents.events.session_manager import RunEventBusManager


@pytest.fixture(autouse=True)
def _restore_runtime_imports():
    """确保前序测试对 sys.modules 的临时替换不会污染 runtime 服务测试。"""
    for module_name in ["model_adapter", "config"]:
        sys.modules.pop(module_name, None)
        importlib.invalidate_caches()
        importlib.import_module(module_name)
    yield
    for module_name in ["model_adapter", "config"]:
        importlib.invalidate_caches()
        importlib.import_module(module_name)


def _build_runtime(**kwargs):
    from services.agent_api_runtime_service import AgentApiRuntimeService

    return AgentApiRuntimeService(**kwargs)


class _DummyConfigManager:
    def __init__(self, active_configs=None, team_configs=None, active_team='default'):
        self._active_configs = active_configs or {}
        self._team_configs = team_configs or {}
        self._active_team = active_team

    def get_all_configs(self):
        return dict(self._active_configs)

    def get_config(self, agent_name):
        return self._active_configs.get(agent_name)

    def get_team_configs(self, team_name):
        if team_name not in self._team_configs:
            raise ValueError(f"team '{team_name}' 不存在")
        return dict(self._team_configs[team_name])

    def get_active_team(self):
        return self._active_team


class _DummyMemoryConfig:
    def __init__(self, *, allowed_scopes=None, write_scopes=None, archive_scopes=None, auto_inject=True):
        self.allowed_scopes = allowed_scopes or []
        self.write_scopes = write_scopes or []
        self.archive_scopes = archive_scopes or []
        self.auto_inject = auto_inject


class _DummyAgentConfig:
    def __init__(self, *, enabled=True, default_entry=False, memory=None, custom_params=None):
        self.enabled = enabled
        self.default_entry = default_entry
        self.memory = memory
        self.custom_params = custom_params or {}


class _DummyAgent:
    def __init__(self, name: str, agent_config=None):
        self.name = name
        self.description = f"{name} desc"
        self.agent_config = agent_config or SimpleNamespace(custom_params={})

    def can_handle(self, task, context=None):
        del task, context
        return True

    def get_info(self):
        return {"name": self.name, "description": self.description}


class _DummyConversationStore:
    def __init__(self, session_map=None):
        self._session_map = session_map or {}

    def get_recent_messages(self, session_id, limit, thread_key=None):
        del session_id, limit, thread_key
        return []

    def get_session(self, session_id):
        return self._session_map.get(session_id)


def test_runtime_service_builds_fresh_execution_orchestrators(monkeypatch):
    def _load_all_agents(self, configs=None):
        del self, configs
        return {
            "orchestrator_agent": _DummyAgent("orchestrator_agent"),
            "qa_agent": _DummyAgent("qa_agent"),
        }

    monkeypatch.setattr(AgentLoader, "load_all_agents", _load_all_agents)
    monkeypatch.setattr(AgentLoader, "resolve_default_entry_agent_name", lambda self, configs=None: "orchestrator_agent")
    run_manager = RunEventBusManager(cleanup_interval=3600)

    runtime = _build_runtime(
        conversation_store=_DummyConversationStore(),
        task_registry_getter=lambda: SimpleNamespace(),
        session_manager_getter=lambda: run_manager,
        session_application=SimpleNamespace(),
        collaboration_application=SimpleNamespace(),
        config_getter=lambda: SimpleNamespace(),
        config_manager_getter=lambda: SimpleNamespace(),
        default_adapter_getter=lambda: SimpleNamespace(),
    )

    orchestrator_a = runtime.create_execution_orchestrator()
    orchestrator_b = runtime.create_execution_orchestrator()
    catalog_a = runtime.get_orchestrator()
    catalog_b = runtime.get_orchestrator()

    assert orchestrator_a is not orchestrator_b
    assert catalog_a is not catalog_b

    assert orchestrator_a.resolve_default_entry_agent() is not orchestrator_b.resolve_default_entry_agent()
    assert orchestrator_a.agents["qa_agent"] is not orchestrator_b.agents["qa_agent"]

    assert getattr(orchestrator_a, "_metrics_collector") is getattr(orchestrator_b, "_metrics_collector")
    assert getattr(catalog_a, "_metrics_collector") is getattr(orchestrator_a, "_metrics_collector")
    run_manager.shutdown()


def test_runtime_context_binds_event_bus_per_run():
    run_manager = RunEventBusManager(cleanup_interval=3600)
    runtime = _build_runtime(
        conversation_store=_DummyConversationStore({
            'session-1': {'session_id': 'session-1', 'metadata': {'workspace_root': 'E:/external/workspace'}},
        }),
        task_registry_getter=lambda: SimpleNamespace(),
        session_manager_getter=lambda: run_manager,
        session_application=SimpleNamespace(),
        collaboration_application=SimpleNamespace(),
        config_getter=lambda: SimpleNamespace(),
        config_manager_getter=lambda: SimpleNamespace(),
        default_adapter_getter=lambda: SimpleNamespace(),
    )

    context_a = runtime.build_context(session_id="session-1", user_id="u1", run_id="run-a", thread_key="root")
    context_b = runtime.build_context(
        session_id="session-1",
        user_id="u1",
        run_id="run-b",
        thread_key="thread-1",
        parent_run_id="run-a",
        parent_call_id="call-1",
    )

    assert context_a.metadata["run_id"] == "run-a"
    assert context_b.metadata["run_id"] == "run-b"
    assert context_a.metadata["thread_key"] == "root"
    assert context_b.metadata["thread_key"] == "thread-1"
    assert context_b.metadata["parent_run_id"] == "run-a"
    assert context_b.metadata["parent_call_id"] == "call-1"
    assert context_a.metadata["event_bus"] is not context_b.metadata["event_bus"]
    assert context_a.metadata['workspace_root'] == 'E:/external/workspace'
    assert context_b.metadata['workspace_root'] == 'E:/external/workspace'
    assert run_manager.get("run-a") is context_a.metadata["event_bus"]
    assert run_manager.get("run-b") is context_b.metadata["event_bus"]

    run_manager.shutdown()




def test_runtime_execution_orchestrator_logs_workspace_root_injection(monkeypatch, caplog):
    import logging

    def _load_all_agents(self, configs=None):
        del self, configs
        return {
            'orchestrator_agent': _DummyAgent('orchestrator_agent'),
            'qa_agent': _DummyAgent('qa_agent'),
        }

    monkeypatch.setattr(AgentLoader, 'load_all_agents', _load_all_agents)
    monkeypatch.setattr(AgentLoader, 'resolve_default_entry_agent_name', lambda self, configs=None: 'orchestrator_agent')
    run_manager = RunEventBusManager(cleanup_interval=3600)

    runtime = _build_runtime(
        conversation_store=_DummyConversationStore({
            'session-log': {'session_id': 'session-log', 'metadata': {'workspace_root': 'E:/workspace/logs'}},
        }),
        task_registry_getter=lambda: SimpleNamespace(),
        session_manager_getter=lambda: run_manager,
        session_application=SimpleNamespace(),
        collaboration_application=SimpleNamespace(),
        config_getter=lambda: SimpleNamespace(),
        config_manager_getter=lambda: SimpleNamespace(),
        default_adapter_getter=lambda: SimpleNamespace(),
    )

    caplog.set_level(logging.DEBUG)
    orchestrator = runtime.create_execution_orchestrator(session_id='session-log')

    assert orchestrator.agents['qa_agent'].agent_config.custom_params['workspace_root'] == 'E:/workspace/logs'
    assert 'session workspace_root 查询: session_id=session-log workspace_root=E:/workspace/logs' in caplog.text
    assert 'execution orchestrator 注入 workspace_root: session_id=session-log workspace_root=E:/workspace/logs' in caplog.text

    run_manager.shutdown()


def test_runtime_execution_orchestrator_applies_session_entry_agent_override(monkeypatch):
    def _load_all_agents(self, configs=None):
        del self, configs
        return {
            'orchestrator_agent': _DummyAgent('orchestrator_agent'),
            'qa_agent': _DummyAgent('qa_agent'),
        }

    monkeypatch.setattr(AgentLoader, 'load_all_agents', _load_all_agents)
    monkeypatch.setattr(AgentLoader, 'resolve_default_entry_agent_name', lambda self, configs=None: 'orchestrator_agent')
    run_manager = RunEventBusManager(cleanup_interval=3600)

    runtime = _build_runtime(
        conversation_store=_DummyConversationStore({
            'session-entry': {'session_id': 'session-entry', 'metadata': {'entry_agent': 'qa_agent'}},
        }),
        task_registry_getter=lambda: SimpleNamespace(),
        session_manager_getter=lambda: run_manager,
        session_application=SimpleNamespace(),
        collaboration_application=SimpleNamespace(),
        config_getter=lambda: SimpleNamespace(),
        config_manager_getter=lambda: SimpleNamespace(),
        default_adapter_getter=lambda: SimpleNamespace(),
    )

    orchestrator = runtime.create_execution_orchestrator(session_id='session-entry')

    assert orchestrator.resolve_default_entry_agent_name() == 'qa_agent'
    assert orchestrator.resolve_default_entry_agent().name == 'qa_agent'

    run_manager.shutdown()


def test_runtime_build_context_exposes_session_entry_agent():
    run_manager = RunEventBusManager(cleanup_interval=3600)
    runtime = _build_runtime(
        conversation_store=_DummyConversationStore({
            'session-1': {
                'session_id': 'session-1',
                'metadata': {'workspace_root': 'E:/external/workspace', 'entry_agent': 'qa_agent'},
            },
        }),
        task_registry_getter=lambda: SimpleNamespace(),
        session_manager_getter=lambda: run_manager,
        session_application=SimpleNamespace(),
        collaboration_application=SimpleNamespace(),
        config_getter=lambda: SimpleNamespace(),
        config_manager_getter=lambda: SimpleNamespace(),
        default_adapter_getter=lambda: SimpleNamespace(),
    )

    context = runtime.build_context(session_id='session-1', user_id='u1', run_id='run-a', thread_key='root')

    assert context.metadata['entry_agent'] == 'qa_agent'

    run_manager.shutdown()


def test_runtime_execution_orchestrator_uses_session_team_configs(monkeypatch):
    captured = {}

    def _load_all_agents(self, configs=None):
        captured['configs'] = configs
        return {
            name: _DummyAgent(name, agent_config=config)
            for name, config in (configs or {}).items()
        }

    monkeypatch.setattr(AgentLoader, 'load_all_agents', _load_all_agents)
    monkeypatch.setattr(
        AgentLoader,
        'resolve_default_entry_agent_name',
        lambda self, configs=None: next((name for name, config in (configs or {}).items() if getattr(config, 'default_entry', False)), None),
    )

    active_configs = {
        'orchestrator_agent': _DummyAgentConfig(default_entry=True),
        'qa_agent': _DummyAgentConfig(),
    }
    team_b_configs = {
        'orchestrator_agent': _DummyAgentConfig(),
        'team_b_agent': _DummyAgentConfig(default_entry=True),
    }
    config_manager = _DummyConfigManager(active_configs=active_configs, team_configs={'team_b': team_b_configs}, active_team='default')
    run_manager = RunEventBusManager(cleanup_interval=3600)
    runtime = _build_runtime(
        conversation_store=_DummyConversationStore({
            'session-team': {'session_id': 'session-team', 'metadata': {'team': 'team_b'}},
        }),
        task_registry_getter=lambda: SimpleNamespace(),
        session_manager_getter=lambda: run_manager,
        session_application=SimpleNamespace(),
        collaboration_application=SimpleNamespace(),
        config_getter=lambda: SimpleNamespace(),
        config_manager_getter=lambda: config_manager,
        default_adapter_getter=lambda: SimpleNamespace(),
    )

    orchestrator = runtime.create_execution_orchestrator(session_id='session-team')

    assert captured['configs'] == team_b_configs
    assert 'team_b_agent' in orchestrator.agents
    assert 'qa_agent' not in orchestrator.agents
    assert orchestrator.resolve_default_entry_agent_name() == 'team_b_agent'
    assert config_manager.get_active_team() == 'default'

    run_manager.shutdown()


def test_runtime_build_context_uses_session_team_memory_config():
    run_manager = RunEventBusManager(cleanup_interval=3600)
    active_configs = {
        'demo_agent': _DummyAgentConfig(
            memory=_DummyMemoryConfig(
                allowed_scopes=['project'],
                write_scopes=['project'],
                archive_scopes=[],
            )
        )
    }
    team_b_configs = {
        'demo_agent': _DummyAgentConfig(
            memory=_DummyMemoryConfig(
                allowed_scopes=['session', 'workspace'],
                write_scopes=['workspace'],
                archive_scopes=['session'],
            )
        )
    }
    config_manager = _DummyConfigManager(active_configs=active_configs, team_configs={'team_b': team_b_configs}, active_team='default')
    runtime = _build_runtime(
        conversation_store=_DummyConversationStore({
            'session-team': {
                'session_id': 'session-team',
                'metadata': {'team': 'team_b', 'workspace_root': 'E:/workspace/team-b'},
            },
        }),
        task_registry_getter=lambda: SimpleNamespace(),
        session_manager_getter=lambda: run_manager,
        session_application=SimpleNamespace(),
        collaboration_application=SimpleNamespace(),
        config_getter=lambda: SimpleNamespace(),
        config_manager_getter=lambda: config_manager,
        default_adapter_getter=lambda: SimpleNamespace(),
    )

    context = runtime.build_context(session_id='session-team', agent_name='demo_agent', memory_query='x')

    assert context.metadata['team'] == 'team_b'
    assert context.metadata['memory_scope_capabilities'] == {
        'allowed_scopes': ['session', 'workspace'],
        'write_scopes': ['workspace'],
        'archive_scopes': ['session'],
    }

    run_manager.shutdown()


def test_runtime_execution_orchestrator_falls_back_when_session_team_missing(monkeypatch, caplog):
    import logging

    captured = {}

    def _load_all_agents(self, configs=None):
        captured['configs'] = configs
        effective_configs = configs or active_configs
        return {
            name: _DummyAgent(name, agent_config=config)
            for name, config in effective_configs.items()
        }

    monkeypatch.setattr(AgentLoader, 'load_all_agents', _load_all_agents)
    monkeypatch.setattr(
        AgentLoader,
        'resolve_default_entry_agent_name',
        lambda self, configs=None: next((name for name, config in ((configs or active_configs)).items() if getattr(config, 'default_entry', False)), None),
    )

    active_configs = {
        'orchestrator_agent': _DummyAgentConfig(default_entry=True),
        'qa_agent': _DummyAgentConfig(),
    }
    config_manager = _DummyConfigManager(active_configs=active_configs, team_configs={}, active_team='default')
    run_manager = RunEventBusManager(cleanup_interval=3600)
    runtime = _build_runtime(
        conversation_store=_DummyConversationStore({
            'session-missing-team': {'session_id': 'session-missing-team', 'metadata': {'team': 'missing_team'}},
        }),
        task_registry_getter=lambda: SimpleNamespace(),
        session_manager_getter=lambda: run_manager,
        session_application=SimpleNamespace(),
        collaboration_application=SimpleNamespace(),
        config_getter=lambda: SimpleNamespace(),
        config_manager_getter=lambda: config_manager,
        default_adapter_getter=lambda: SimpleNamespace(),
    )

    caplog.set_level(logging.WARNING)
    orchestrator = runtime.create_execution_orchestrator(session_id='session-missing-team')

    assert captured['configs'] is None
    assert 'qa_agent' in orchestrator.agents
    assert "session team 不存在或加载失败，回退 active_team" in caplog.text

    run_manager.shutdown()
