# -*- coding: utf-8 -*-
"""Runtime dispatcher helpers for local handlers and MCP tools."""

from __future__ import annotations

import inspect
import logging

from execution.observability import get_current_execution_observability_fields
from tools.runtime.registration import TOOL_HANDLERS
from tools.runtime.response_builder import error_result
from tools.tool_registry import get_tool_registry

logger = logging.getLogger(__name__)
_TOOL_REGISTRY = get_tool_registry()


def get_tool_handler(tool_name: str):
    return TOOL_HANDLERS.get(tool_name)


def build_handler_call_arguments(handler, arguments, **context):
    call_arguments = dict(arguments)
    sig_params = inspect.signature(handler).parameters
    for key, value in context.items():
        if key in sig_params:
            call_arguments.setdefault(key, value)
    return call_arguments


def execute_mcp_tool(tool_name, arguments, *, session_id=None):
    from services.mcp_service import get_mcp_service

    parsed = _TOOL_REGISTRY.parse_mcp_tool_name(tool_name)
    if not parsed:
        return error_result(f"无效的 MCP 工具名: {tool_name}", tool_name=tool_name)
    server_name, original_tool = parsed
    current_fields = get_current_execution_observability_fields()
    logger.info(
        "分发 MCP 工具 tool_name=%s server_name=%s original_tool=%s session_id=%s run_id=%s request_id=%s",
        tool_name,
        server_name,
        original_tool,
        session_id or current_fields.get("session_id"),
        current_fields.get("run_id"),
        current_fields.get("request_id"),
    )
    return get_mcp_service().call_tool(
        server_name,
        original_tool,
        arguments,
        session_id=session_id,
        run_id=current_fields.get("run_id"),
        request_id=current_fields.get("request_id"),
    )
