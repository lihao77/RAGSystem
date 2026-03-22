# -*- coding: utf-8 -*-
from types import SimpleNamespace

from agents.config.loader import AgentLoader
from agents.implementations.orchestrator.agent import OrchestratorAgent


class _DummyConfigManager:
    def __init__(self, configs):
        self._configs = configs

    def get_config(self, agent_name):
        return self._configs.get(agent_name)

    def get_all_configs(self):
        return dict(self._configs)


def _make_agent_config(agent_name: str, agent_type: str, enabled: bool = True):
    return SimpleNamespace(
        agent_name=agent_name,
        display_name=agent_name,
        description=f"{agent_name} desc",
        enabled=enabled,
        llm=SimpleNamespace(merge_with_default=lambda system_config, model_adapter=None: {}),
        llm_tiers={},
        tools=SimpleNamespace(enabled_tools=[]),
        skills=SimpleNamespace(enabled_skills=[], auto_inject=False),
        mcp=None,
        custom_params={'type': agent_type, 'behavior': {}},
    )


def test_loader_builds_orchestrator_via_unified_factory():
    configs = {
        'orchestrator_agent': _make_agent_config('orchestrator_agent', 'orchestrator', enabled=False),
    }
    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=SimpleNamespace(),
        config_manager=_DummyConfigManager(configs),
    )
    loader._resolve_tools_and_skills = lambda agent_config: ([], [])

    agents = loader.load_all_agents()

    assert 'orchestrator_agent' in agents
    assert isinstance(agents['orchestrator_agent'], OrchestratorAgent)


def test_loader_rejects_orchestrator_without_orchestrator_runtime():
    configs = {
        'orchestrator_agent': _make_agent_config('orchestrator_agent', 'orchestrator'),
    }
    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=None,
        config_manager=_DummyConfigManager(configs),
    )
    loader._resolve_tools_and_skills = lambda agent_config: ([], [])

    agent = loader.load_agent(
        'orchestrator_agent',
        agent_config=configs['orchestrator_agent'],
        ignore_enabled=True,
    )

    assert agent is None
