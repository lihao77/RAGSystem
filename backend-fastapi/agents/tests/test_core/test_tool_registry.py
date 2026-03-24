# -*- coding: utf-8 -*-

from tools.bootstrap import bootstrap_tool_system
from tools.tool_registry import get_tool_registry
from tools.catalog.mcp_tools import (
    is_mcp_tool,
    mcp_tool_to_openai_format,
    parse_mcp_tool_name,
)

bootstrap_tool_system()


def test_tool_registry_groups_base_and_document_tools():
    registry = get_tool_registry()

    base_tools = registry.get_base_tools()
    base_names = [tool["function"]["name"] for tool in base_tools]
    document_names = [tool["function"]["name"] for tool in registry.get_document_tools()]
    builtin_names = [tool["function"]["name"] for tool in registry.get_builtin_tools()]
    agent_names = [tool["function"]["name"] for tool in registry.get_agent_tools()]

    assert "activate_skill" in base_names
    assert "execute_skill_script" in base_names
    assert "read_file" in base_names
    assert "request_user_input" in builtin_names
    assert agent_names == ["call_agent"]
    assert "read_file" in document_names
    assert "execute_skill_script" not in document_names
    assert base_names.count("read_file") == 1
    assert registry.get_tool_by_name("read_document") is None
    assert registry.get_tool_by_name("chunk_document") is None
    assert registry.get_tool_category("read_file") == "document"
    assert registry.get_tool_source("read_file") == "document"
    assert registry.get_tool_category("activate_skill") == "skill"
    assert registry.get_tool_category("request_user_input") == "builtin"
    assert registry.get_tool_category("call_agent") == "agent"


def test_tool_registry_lists_direct_tool_summaries_with_source():
    registry = get_tool_registry()

    summaries = registry.list_direct_tool_summaries()
    names = {item["name"] for item in summaries}
    read_file = next(item for item in summaries if item["name"] == "read_file")

    assert "request_user_input" not in names
    assert "call_agent" not in names
    assert "execute_skill_script" not in names
    assert read_file["category"] == "document"
    assert read_file["source"] == "document"


def test_tool_registry_exposes_base_tool_accessors():
    registry = get_tool_registry()

    all_contract_names = {contract.name for contract in registry.get_all_contracts()}

    assert registry.get_tool_by_name("execute_skill_script")["function"]["name"] == "execute_skill_script"
    assert registry.get_tool_by_name("call_agent")["function"]["name"] == "call_agent"
    assert "read_file" not in registry.get_code_callable_tools()
    assert "execute_bash" not in registry.get_code_callable_tools()
    assert "execute_skill_script" not in registry.get_code_callable_tools()
    assert "preview_data_structure" in registry.get_code_callable_tools()
    assert "execute_skill_script" in all_contract_names
    assert "request_user_input" in all_contract_names
    assert "call_agent" in all_contract_names


def test_registry_source_queries_are_unique():
    registry = get_tool_registry()

    assert [tool["function"]["name"] for tool in registry.get_agent_tools()] == ["call_agent"]
    assert registry.get_builtin_tool_names() == {"request_user_input"}
    assert {tool["function"]["name"] for tool in registry.get_skill_tools()} == {
        "activate_skill", "load_skill_resource", "execute_skill_script", "get_skill_info"
    }


def test_mcp_helpers_still_delegate_consistently():
    fake_mcp_tool = type(
        "_FakeMcpTool",
        (),
        {
            "name": "search",
            "description": "Search remote service",
            "inputSchema": {"type": "object", "properties": {}, "required": []},
        },
    )()
    converted = mcp_tool_to_openai_format("demo", fake_mcp_tool)
    assert converted["function"]["name"] == "mcp__demo__search"
    assert parse_mcp_tool_name("mcp__demo__search") == ("demo", "search")
    assert is_mcp_tool("mcp__demo__search") is True
