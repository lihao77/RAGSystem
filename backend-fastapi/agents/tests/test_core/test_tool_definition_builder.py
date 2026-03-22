# -*- coding: utf-8 -*-

import pytest

from tools.tool_definition_builder import ToolContract, build_function_tool, build_function_tools


def test_build_function_tool_emits_openai_style_schema_with_extended_fields():
    contract = ToolContract(
        name="demo_tool",
        description="demo",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
            },
            "required": ["query"],
        },
        returns={
            "type": "object",
            "description": "demo returns",
            "shape": {"content": "string"},
        },
        usage_contract=["must pass query"],
        examples=[{"query": "demo"}],
        source="test",
    )

    tool_def = build_function_tool(contract)

    assert tool_def["type"] == "function"
    assert tool_def["function"]["name"] == "demo_tool"
    assert tool_def["function"]["parameters"]["required"] == ["query"]
    assert tool_def["function"]["returns"]["description"] == "demo returns"
    assert tool_def["function"]["usage_contract"] == ["must pass query"]
    assert tool_def["function"]["examples"][0]["query"] == "demo"
    assert tool_def["function"]["source"] == "test"


def test_build_function_tool_rejects_required_field_not_in_properties():
    contract = ToolContract(
        name="broken_tool",
        description="broken",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
            },
            "required": ["missing"],
        },
    )

    with pytest.raises(ValueError, match="required 包含未定义字段"):
        build_function_tool(contract)


def test_build_function_tools_batch_builds_multiple_contracts():
    tools = build_function_tools([
        ToolContract(
            name="tool_a",
            description="a",
            parameters={"type": "object", "properties": {}, "required": []},
        ),
        ToolContract(
            name="tool_b",
            description="b",
            parameters={"type": "object", "properties": {}, "required": []},
        ),
    ])

    assert [tool["function"]["name"] for tool in tools] == ["tool_a", "tool_b"]
