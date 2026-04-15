# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.config.loader import AgentLoader


class _FakeRegistry:
    def __init__(self):
        self._direct_tools = [
            {"function": {"name": "read_file", "source": "document"}},
        ]
        self._task_tools = [
            {"function": {"name": "task_create", "source": "task"}},
            {"function": {"name": "task_get", "source": "task"}},
            {"function": {"name": "task_update", "source": "task"}},
            {"function": {"name": "task_list", "source": "task"}},
            {"function": {"name": "task_stop", "source": "task"}},
        ]

    def get_direct_tools(self):
        return list(self._direct_tools)

    def get_task_tools(self):
        return list(self._task_tools)

    def get_skill_tools(self):
        return []

    def get_agent_tools(self):
        return []

    def get_tool_by_name(self, name):
        if name == 'request_user_input':
            return {"function": {"name": "request_user_input", "source": "builtin"}}
        return None


def _agent_config(*, enabled_tools=None, workflow=False, background=False):
    return SimpleNamespace(
        agent_name='demo_agent',
        tools=SimpleNamespace(enabled_tools=list(enabled_tools or [])),
        skills=None,
        mcp=None,
        delegation=None,
        memory=SimpleNamespace(allowed_scopes=[], write_scopes=[], archive_scopes=[]),
        tasks=SimpleNamespace(workflow=workflow, background=background),
    )


def test_agent_loader_injects_workflow_task_tools_from_tasks_config():
    loader = AgentLoader(model_adapter=None, system_config=None, orchestrator=object(), config_manager=object())
    loader._tool_registry = _FakeRegistry()

    tools, skills = loader._resolve_tools_and_skills(_agent_config(workflow=True, background=False))

    tool_names = {tool['function']['name'] for tool in tools}
    assert {'task_create', 'task_get', 'task_update', 'task_list'} <= tool_names
    assert 'task_output' not in tool_names
    assert 'task_stop' not in tool_names
    assert skills == []


def test_agent_loader_injects_background_task_tools_from_tasks_config():
    loader = AgentLoader(model_adapter=None, system_config=None, orchestrator=object(), config_manager=object())
    loader._tool_registry = _FakeRegistry()

    tools, _ = loader._resolve_tools_and_skills(_agent_config(workflow=False, background=True))

    tool_names = {tool['function']['name'] for tool in tools}
    assert {'task_stop'} <= tool_names
    assert 'task_output' not in tool_names
    assert 'task_create' not in tool_names
    assert 'task_get' not in tool_names
    assert 'task_update' not in tool_names
    assert 'task_list' not in tool_names


def test_agent_loader_injects_both_task_domains_together():
    loader = AgentLoader(model_adapter=None, system_config=None, orchestrator=object(), config_manager=object())
    loader._tool_registry = _FakeRegistry()

    tools, _ = loader._resolve_tools_and_skills(_agent_config(workflow=True, background=True))

    tool_names = {tool['function']['name'] for tool in tools}
    assert {'task_create', 'task_get', 'task_update', 'task_list', 'task_stop'} <= tool_names
    assert 'task_output' not in tool_names


def test_agent_loader_does_not_require_enabled_tools_for_task_capability():
    loader = AgentLoader(model_adapter=None, system_config=None, orchestrator=object(), config_manager=object())
    loader._tool_registry = _FakeRegistry()

    tools, _ = loader._resolve_tools_and_skills(_agent_config(enabled_tools=[], workflow=True, background=False))

    tool_names = {tool['function']['name'] for tool in tools}
    assert 'task_create' in tool_names
    assert 'read_file' not in tool_names
