# -*- coding: utf-8 -*-

from types import SimpleNamespace

from tools.auto_discovery import discover_decorated_tools
from tools.catalog.agent_tools import AGENT_TOOLS_EXAMPLE, get_agent_tools
from tools.catalog.builtin_tools import REQUEST_USER_INPUT_TOOL, get_builtin_tools_for_worker
from tools.catalog.mcp_tools import (
    is_mcp_tool,
    mcp_tool_to_openai_format,
    parse_mcp_tool_name,
)
from tools.catalog.skill_tools import SKILLS_SYSTEM_TOOLS
from tools.catalog.static_tools import STATIC_TOOL_CONTRACTS
from tools.tool_registry import get_tool_registry
from tools.tool_executor_modules.dispatcher import _merge_decorated_handlers
from tools.permissions import _merge_decorated_permissions


discover_decorated_tools()
_merge_decorated_handlers()
_merge_decorated_permissions()
registry = get_tool_registry()
registry.register_extra_contracts([info["contract"] for info in discover_decorated_tools().values()])


def test_tool_registry_groups_default_and_document_tools():
    registry = get_tool_registry()

    default_tools = registry.get_default_tools()
    default_names = [tool["function"]["name"] for tool in default_tools]
    document_names = [tool["function"]["name"] for tool in registry.get_document_tools()]

    assert "activate_skill" in default_names
    assert "execute_skill_script" in default_names
    assert "read_file" in default_names
    assert "read_file" in document_names
    assert "execute_skill_script" not in document_names
    assert "create_chart" not in default_names
    assert default_names.count("read_file") == 1
    assert registry.get_tool_category("read_file") == "document"
    assert registry.get_tool_source("read_file") == "document"
    assert registry.get_tool_category("activate_skill") == "skill"
    assert registry.get_tool_category("execute_skill_script") == "skill"
    assert registry.get_tool_category("execute_code") == "execution"


def test_tool_registry_lists_configurable_tool_summaries_with_source():
    registry = get_tool_registry()

    summaries = registry.list_configurable_tool_summaries()
    execute_skill_script = next(item for item in summaries if item["name"] == "execute_skill_script")
    read_file = next(item for item in summaries if item["name"] == "read_file")

    assert execute_skill_script["category"] == "skill"
    assert execute_skill_script["source"] == "skill"
    assert read_file["category"] == "document"
    assert read_file["source"] == "document"


def test_tool_registry_exposes_default_tool_accessors():
    registry = get_tool_registry()

    assert registry.get_default_tools() == registry.get_all_base_tools()
    assert registry.get_tool_by_name("execute_skill_script")["function"]["name"] == "execute_skill_script"
    assert registry.get_tool_by_name("create_chart") is None
    assert "read_file" not in registry.get_code_callable_tools()
    assert "execute_bash" not in registry.get_code_callable_tools()
    assert "execute_skill_script" not in registry.get_code_callable_tools()
    assert "preview_data_structure" in registry.get_code_callable_tools()
    assert any(contract.name == "execute_skill_script" for contract in registry.get_static_contracts())
    assert not any(contract.name == "create_chart" for contract in registry.get_static_contracts())


def test_document_and_builtin_catalog_exports_work():
    registry = get_tool_registry()

    assert REQUEST_USER_INPUT_TOOL == registry.get_request_user_input_tool()
    assert registry.get_skill_tools()
    assert {tool["function"]["name"] for tool in registry.get_skill_tools()} == {
        "activate_skill", "load_skill_resource", "execute_skill_script", "get_skill_info"
    }

    tools = get_builtin_tools_for_worker([REQUEST_USER_INPUT_TOOL])
    assert [tool["function"]["name"] for tool in tools].count("request_user_input") == 1


def test_agent_and_mcp_catalog_helpers_delegate_consistently():
    registry = get_tool_registry()
    demo_agent = SimpleNamespace(
        name="qa",
        description="demo",
        agent_config=SimpleNamespace(
            display_name="QA",
            description="QA agent",
            custom_params={"behavior": {"use_cases": "qa"}},
        ),
        available_tools=[{"function": {"name": "read_file"}}],
    )

    compat_tools = get_agent_tools({"qa_agent": demo_agent})
    registry_tools = registry.get_agent_tools({"qa_agent": demo_agent})

    assert compat_tools == registry_tools
    assert AGENT_TOOLS_EXAMPLE

    fake_mcp_tool = SimpleNamespace(
        name="search",
        description="Search remote service",
        inputSchema={"type": "object", "properties": {}, "required": []},
    )
    converted = mcp_tool_to_openai_format("demo", fake_mcp_tool)
    assert converted["function"]["name"] == "mcp__demo__search"
    assert parse_mcp_tool_name("mcp__demo__search") == ("demo", "search")
    assert is_mcp_tool("mcp__demo__search") is True
