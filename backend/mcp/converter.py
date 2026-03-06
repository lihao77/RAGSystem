# -*- coding: utf-8 -*-
"""
MCP 工具格式转换器

MCP Tool Schema → OpenAI Function Calling 格式
"""

import logging
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# MCP 工具名前缀
MCP_TOOL_PREFIX = "mcp__"


def mcp_tool_to_openai_format(server_name: str, mcp_tool) -> dict:
    """
    MCP 工具 → OpenAI function calling 格式

    命名规则：mcp__{server_name}__{tool_name}

    Args:
        server_name: MCP Server 名称
        mcp_tool: MCP SDK 返回的 Tool 对象（有 name, description, inputSchema 属性）

    Returns:
        OpenAI function calling 格式的工具定义
    """
    tool_name = f"{MCP_TOOL_PREFIX}{server_name}__{mcp_tool.name}"
    description = mcp_tool.description or ""
    prefixed_desc = f"[MCP:{server_name}] {description}"

    input_schema = mcp_tool.inputSchema if hasattr(mcp_tool, 'inputSchema') else None
    if not input_schema:
        input_schema = {"type": "object", "properties": {}}

    return {
        "type": "function",
        "function": {
            "name": tool_name,
            "description": prefixed_desc,
            "parameters": input_schema
        }
    }


def mcp_tools_to_openai_format(server_name: str, mcp_tools: list) -> List[dict]:
    """
    批量转换 MCP 工具列表

    Args:
        server_name: MCP Server 名称
        mcp_tools: MCP SDK 返回的 Tool 对象列表

    Returns:
        OpenAI function calling 格式的工具定义列表
    """
    result = []
    for tool in mcp_tools:
        try:
            converted = mcp_tool_to_openai_format(server_name, tool)
            result.append(converted)
        except Exception as e:
            logger.warning(f"转换 MCP 工具失败 ({server_name}/{getattr(tool, 'name', '?')}): {e}")
    return result


def parse_mcp_tool_name(tool_name: str) -> Optional[Tuple[str, str]]:
    """
    解析 mcp__server__tool 格式

    Args:
        tool_name: 完整工具名，如 "mcp__filesystem__read_file"

    Returns:
        (server_name, original_tool_name) 或 None（格式不匹配）
    """
    if not tool_name.startswith(MCP_TOOL_PREFIX):
        return None

    rest = tool_name[len(MCP_TOOL_PREFIX):]
    parts = rest.split("__", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None

    return (parts[0], parts[1])


def is_mcp_tool(tool_name: str) -> bool:
    """检查是否是 MCP 工具名"""
    return tool_name.startswith(MCP_TOOL_PREFIX)
