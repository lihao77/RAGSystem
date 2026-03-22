# -*- coding: utf-8 -*-

from types import SimpleNamespace

from tools.catalog.mcp_tools import mcp_tool_to_openai_format


def test_mcp_tool_conversion_includes_generic_return_contract():
    fake_tool = SimpleNamespace(
        name="search",
        description="Search remote service",
        inputSchema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
            },
            "required": ["query"],
        },
    )

    converted = mcp_tool_to_openai_format("demo", fake_tool)
    func = converted["function"]

    assert func["name"] == "mcp__demo__search"
    assert func["returns"]["description"] == "返回结构由 MCP Server 定义，可能因工具而异"
    assert "usage_contract" in func
    assert "返回结构可能不固定" in func["usage_contract"][1]
