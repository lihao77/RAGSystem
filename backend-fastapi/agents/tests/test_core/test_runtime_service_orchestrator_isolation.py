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


class _DummyAgent:
    def __init__(self, name: str):
        self.name = name
        self.description = f"{name} desc"

    def can_handle(self, task, context=None):
        del task, context
        return True

    def get_info(self):
        return {"name": self.name, "description": self.description}


class _DummyConversationStore:
    def get_recent_messages(self, session_id, limit):
        del session_id, limit
        return []


def test_runtime_service_builds_fresh_execution_orchestrators(monkeypatch):
    def _load_all_agents(self):
        del self
        return {
            "orchestrator_agent": _DummyAgent("orchestrator_agent"),
            "qa_agent": _DummyAgent("qa_agent"),
        }

    monkeypatch.setattr(AgentLoader, "load_all_agents", _load_all_agents)
    monkeypatch.setattr(AgentLoader, "resolve_default_entry_agent_name", lambda self: "orchestrator_agent")
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
        conversation_store=_DummyConversationStore(),
        task_registry_getter=lambda: SimpleNamespace(),
        session_manager_getter=lambda: run_manager,
        session_application=SimpleNamespace(),
        collaboration_application=SimpleNamespace(),
        config_getter=lambda: SimpleNamespace(),
        config_manager_getter=lambda: SimpleNamespace(),
        default_adapter_getter=lambda: SimpleNamespace(),
    )

    context_a = runtime.build_context(session_id="session-1", user_id="u1", run_id="run-a")
    context_b = runtime.build_context(session_id="session-1", user_id="u1", run_id="run-b")

    assert context_a.metadata["run_id"] == "run-a"
    assert context_b.metadata["run_id"] == "run-b"
    assert context_a.metadata["event_bus"] is not context_b.metadata["event_bus"]
    assert run_manager.get("run-a") is context_a.metadata["event_bus"]
    assert run_manager.get("run-b") is context_b.metadata["event_bus"]

    run_manager.shutdown()
