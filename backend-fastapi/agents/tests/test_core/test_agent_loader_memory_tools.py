# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.config.loader import AgentLoader


class _FakeRegistry:
    def __init__(self):
        self._direct_tools = [
            {"function": {"name": "read_file", "source": "document"}},
            {"function": {"name": "list_memory_index", "source": "decorator"}},
            {"function": {"name": "read_memory_entry", "source": "decorator"}},
            {"function": {"name": "write_memory", "source": "decorator"}},
            {"function": {"name": "archive_memory", "source": "decorator"}},
        ]

    def get_direct_tools(self):
        return list(self._direct_tools)

    def get_skill_tools(self):
        return []

    def get_agent_tools(self):
        return []

    def get_tool_by_name(self, name):
        if name == 'request_user_input':
            return {"function": {"name": "request_user_input", "source": "builtin"}}
        return None


def test_agent_loader_injects_memory_tools_by_default():
    loader = AgentLoader(model_adapter=None, system_config=None, orchestrator=object(), config_manager=object())
    loader._tool_registry = _FakeRegistry()
    agent_config = SimpleNamespace(
        agent_name='demo_agent',
        tools=SimpleNamespace(enabled_tools=[]),
        skills=None,
        mcp=None,
        delegation=None,
    )

    tools, skills = loader._resolve_tools_and_skills(agent_config)

    tool_names = {tool['function']['name'] for tool in tools}
    assert {'list_memory_index', 'read_memory_entry', 'write_memory', 'archive_memory', 'request_user_input'} <= tool_names
    assert skills == []
