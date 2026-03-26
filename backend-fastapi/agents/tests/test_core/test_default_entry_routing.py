# -*- coding: utf-8 -*-
from types import SimpleNamespace

from agents.config.loader import AgentLoader
from agents.core import AgentContext
from agents.core.default_entry import DefaultEntryAgentProvider
from agents.core.orchestrator import AgentOrchestrator
from agents.core.registry import AgentRegistry


class _StubAgent:
    def __init__(self, name: str):
        self.name = name
        self.description = name

    def can_handle(self, task, context=None):
        del task, context
        return True

    def get_info(self):
        return {"name": self.name}


class _DummyConfigManager:
    def __init__(self, configs):
        self._configs = configs

    def get_all_configs(self):
        return dict(self._configs)


def _make_cfg(agent_name: str, *, default_entry: bool = False):
    custom_params = {'type': 'react'}
    if default_entry:
        custom_params['default_entry'] = True
    return SimpleNamespace(custom_params=custom_params, default_entry=default_entry)


def test_preferred_agent_overrides_default_entry():
    registry = AgentRegistry()
    default_agent = _StubAgent("orchestrator_agent")
    preferred = _StubAgent("qa_agent")
    registry.register(default_agent)
    registry.register(preferred)

    orchestrator = AgentOrchestrator(
        registry=registry,
        default_entry_provider=DefaultEntryAgentProvider(default_agent_name="orchestrator_agent"),
    )

    routed = orchestrator.route_task(
        "task",
        AgentContext(session_id="s1"),
        preferred_agent="qa_agent",
    )

    assert routed is preferred


def test_loader_resolves_configured_default_entry_agent():
    configs = {
        'orchestrator_agent': _make_cfg('orchestrator_agent'),
        'qa_agent': _make_cfg('qa_agent', default_entry=True),
    }
    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=SimpleNamespace(),
        config_manager=_DummyConfigManager(configs),
    )

    assert loader.resolve_default_entry_agent_name() == 'qa_agent'


def test_route_task_falls_back_to_capable_agent_when_default_entry_unavailable():
    registry = AgentRegistry()
    fallback_agent = _StubAgent("fallback_agent")
    registry.register(fallback_agent)

    orchestrator = AgentOrchestrator(
        registry=registry,
        default_entry_provider=DefaultEntryAgentProvider(default_agent_name="missing_agent"),
    )

    routed = orchestrator.route_task(
        "task",
        AgentContext(session_id="s1"),
        preferred_agent=None,
    )

    assert routed is fallback_agent


def test_orchestrator_resolves_default_entry_agent_instance():
    registry = AgentRegistry()
    default_agent = _StubAgent("qa_agent")
    registry.register(default_agent)

    orchestrator = AgentOrchestrator(
        registry=registry,
        default_entry_provider=DefaultEntryAgentProvider(default_agent_name="qa_agent"),
    )

    assert orchestrator.resolve_default_entry_agent_name() == "qa_agent"
    assert orchestrator.resolve_default_entry_agent() is default_agent
