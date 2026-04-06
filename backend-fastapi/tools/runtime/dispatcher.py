# -*- coding: utf-8 -*-
"""Runtime dispatcher helpers for local handlers and MCP tools."""

from __future__ import annotations

import inspect

from tools.runtime.mcp_gateway import execute_mcp_tool as execute_mcp_tool_via_gateway
from tools.runtime.registration import TOOL_HANDLERS


def get_tool_handler(tool_name: str):
    return TOOL_HANDLERS.get(tool_name)


def build_handler_call_arguments(handler, context) -> dict:
    """从 ToolUseContext 中提取 handler 所需的参数。"""
    call_arguments = dict(getattr(context, 'arguments', {}) or {})
    sig_params = inspect.signature(handler).parameters
    for key in (
        'session_id',
        'team_name',
        'workspace_root',
        'run_id',
        'agent_config',
        'event_bus',
        'user_role',
        'caller',
        'cancel_event',
        'parent_call_id',
        'current_agent_name',
        'tool_call_id',
        'round',
        'order',
        'round_index',
        'request_id',
    ):
        if key in sig_params and hasattr(context, key):
            value = getattr(context, key)
            if value is not None:
                call_arguments.setdefault(key, value)
    return call_arguments


def execute_mcp_tool(context) -> object:
    """通过 MCP gateway 执行工具，接受 ToolUseContext。"""
    return execute_mcp_tool_via_gateway(context)
