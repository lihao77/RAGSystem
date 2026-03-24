# -*- coding: utf-8 -*-
"""MCP tool definition adapters."""

from __future__ import annotations

import logging
from typing import List

from tools.contracts.tool_contracts import ToolContract, build_function_tool
from tools.runtime.mcp_gateway import MCP_TOOL_PREFIX

logger = logging.getLogger(__name__)


def mcp_tool_to_openai_format(server_name: str, mcp_tool) -> dict:
    """Convert one MCP tool into the internal OpenAI-style function schema."""
    tool_name = f"{MCP_TOOL_PREFIX}{server_name}__{mcp_tool.name}"
    description = mcp_tool.description or ""
    prefixed_desc = f"[MCP:{server_name}] {description}"

    input_schema = mcp_tool.inputSchema if hasattr(mcp_tool, "inputSchema") else None
    if not input_schema:
        input_schema = {"type": "object", "properties": {}}

    contract = ToolContract(
        name=tool_name,
        description=prefixed_desc,
        parameters=input_schema,
        returns={
            "type": "object",
            "description": "返回结构由 MCP Server 定义，可能因工具而异",
            "shape": {
                "content": "server_defined",
                "metadata": "server_defined",
            },
        },
        usage_contract=[
            "先根据 description 和 parameters 判断该 MCP 工具适用场景",
            "返回结构可能不固定，链式传递时优先使用 result_N.content",
            "若结果是大对象，先读取关键信息再决定是否继续传递给下游工具",
        ],
        source="mcp",
    )
    return build_function_tool(contract)


def mcp_tools_to_openai_format(server_name: str, mcp_tools: list) -> List[dict]:
    """Batch-convert MCP tool definitions."""
    result = []
    for tool in mcp_tools:
        try:
            result.append(mcp_tool_to_openai_format(server_name, tool))
        except Exception as error:
            logger.warning("转换 MCP 工具失败 (%s/%s): %s", server_name, getattr(tool, "name", "?"), error)
    return result
