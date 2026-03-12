# -*- coding: utf-8 -*-
"""Framework-level builtin tool definitions."""

from __future__ import annotations

from copy import deepcopy

from tools.tool_definition_builder import ToolContract, build_function_tool


REQUEST_USER_INPUT_CONTRACT = ToolContract(
    name="request_user_input",
    description=(
        "当你需要用户提供额外信息才能继续完成任务时使用此工具。"
        "调用后系统会暂停执行并向用户展示输入对话框，等待用户填写后继续。\n\n"
        "**适用场景**：\n"
        "- 任务描述不完整，缺少关键参数（如文件路径、目标名称）\n"
        "- 需要用户从多个选项中选择一个处理方向\n"
        "- 需要用户确认某个假设再继续\n\n"
        "**不适用场景**：\n"
        "- 你已有足够信息可以完成任务\n"
        "- 可以通过工具查询获得所需信息\n"
        "- 仅需要用户审批（高风险工具会自动触发审批，无需此工具）"
    ),
    parameters={
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "向用户展示的问题或说明，应清晰描述需要什么信息"
            },
            "input_type": {
                "type": "string",
                "enum": ["text", "select"],
                "description": (
                    "输入类型：'text' 让用户自由输入文本；"
                    "'select' 从预设选项中选择（需同时提供 options）"
                )
            },
            "options": {
                "type": "array",
                "items": {"type": "string"},
                "description": "当 input_type='select' 时提供的选项列表，例如：['选项A', '选项B', '选项C']"
            }
        },
        "required": ["prompt"]
    },
    source="builtin",
)

REQUEST_USER_INPUT_TOOL = build_function_tool(REQUEST_USER_INPUT_CONTRACT)
BUILTIN_TOOL_NAMES = {REQUEST_USER_INPUT_TOOL["function"]["name"]}


def _append_builtin_once(base_tools: list[dict], builtin_tool: dict) -> list[dict]:
    existing = {tool["function"]["name"] for tool in base_tools}
    result = list(base_tools)
    if builtin_tool["function"]["name"] not in existing:
        result.append(deepcopy(builtin_tool))
    return result


def get_builtin_tools_for_react(base_tools: list[dict]) -> list[dict]:
    """Append builtin pseudo-tools needed by ReAct runtime."""
    return _append_builtin_once(base_tools, REQUEST_USER_INPUT_TOOL)


def get_builtin_tools_for_master(base_tools: list[dict]) -> list[dict]:
    """Append builtin pseudo-tools needed by Master runtime."""
    return _append_builtin_once(base_tools, REQUEST_USER_INPUT_TOOL)
