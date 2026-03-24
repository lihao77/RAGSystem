# -*- coding: utf-8 -*-
"""Runtime dispatcher helpers for local handlers and MCP tools."""

from __future__ import annotations

import inspect

from tools.runtime.mcp_gateway import execute_mcp_tool as execute_mcp_tool_via_gateway
from tools.runtime.registration import TOOL_HANDLERS


def get_tool_handler(tool_name: str):
    return TOOL_HANDLERS.get(tool_name)


def build_handler_call_arguments(handler, arguments, **context):
    call_arguments = dict(arguments)
    sig_params = inspect.signature(handler).parameters
    for key, value in context.items():
        if key in sig_params:
            call_arguments.setdefault(key, value)
    return call_arguments


def execute_mcp_tool(tool_name, arguments, *, session_id=None, run_id=None, request_id=None):
    return execute_mcp_tool_via_gateway(
        tool_name,
        arguments,
        session_id=session_id,
        run_id=run_id,
        request_id=request_id,
    )
