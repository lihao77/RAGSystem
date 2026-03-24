# -*- coding: utf-8 -*-
"""Unified runtime gateway for expanded MCP tools."""

from __future__ import annotations

import logging
from typing import Any, Optional, Tuple

from execution.observability import get_current_execution_observability_fields
from tools.runtime.response_builder import error_result

logger = logging.getLogger(__name__)

MCP_TOOL_PREFIX = "mcp__"


def parse_mcp_tool_name(tool_name: str) -> Optional[Tuple[str, str]]:
    """Parse expanded MCP tool names like ``mcp__server__tool``."""
    if not isinstance(tool_name, str) or not tool_name.startswith(MCP_TOOL_PREFIX):
        return None

    rest = tool_name[len(MCP_TOOL_PREFIX):]
    server_name, separator, original_tool_name = rest.partition("__")
    if not separator or not server_name or not original_tool_name:
        return None

    return server_name, original_tool_name


def is_mcp_tool(tool_name: str) -> bool:
    """Whether the tool name is a valid expanded MCP tool name."""
    return parse_mcp_tool_name(tool_name) is not None


def execute_mcp_tool(
    tool_name: str,
    arguments: dict[str, Any],
    *,
    session_id: Optional[str] = None,
    run_id: Optional[str] = None,
    request_id: Optional[str] = None,
):
    """Execute an expanded MCP tool via the shared runtime gateway."""
    parsed = parse_mcp_tool_name(tool_name)
    if not parsed:
        return error_result(f"无效的 MCP 工具名: {tool_name}", tool_name=tool_name)

    server_name, original_tool_name = parsed
    current_fields = get_current_execution_observability_fields()
    effective_session_id = session_id or current_fields.get("session_id")
    effective_run_id = run_id or current_fields.get("run_id")
    effective_request_id = request_id or current_fields.get("request_id")

    logger.info(
        "MCP gateway 执行 tool_name=%s server_name=%s original_tool=%s session_id=%s run_id=%s request_id=%s",
        tool_name,
        server_name,
        original_tool_name,
        effective_session_id,
        effective_run_id,
        effective_request_id,
    )

    from services.mcp_service import get_mcp_service

    return get_mcp_service().call_tool(
        server_name,
        original_tool_name,
        arguments or {},
        session_id=effective_session_id,
        run_id=effective_run_id,
        request_id=effective_request_id,
    )


__all__ = [
    "MCP_TOOL_PREFIX",
    "execute_mcp_tool",
    "is_mcp_tool",
    "parse_mcp_tool_name",
]
