# -*- coding: utf-8 -*-
"""Canonical runtime entrypoint for tool execution."""

from __future__ import annotations

import concurrent.futures
import logging
import time

from tools.contracts.result_models import ToolExecutionResult
from tools.runtime.approvals import _obs_suffix, request_user_approval_if_needed
from tools.runtime.dispatcher import build_handler_call_arguments, execute_mcp_tool, get_tool_handler
from tools.runtime.registration import TOOL_HANDLERS
from tools.runtime.response_builder import error_result, success_result
from tools.tool_registry import get_tool_registry
from utils.timeout_pause import get_current_timer, set_current_timer

logger = logging.getLogger(__name__)
_TOOL_REGISTRY = get_tool_registry()
_DEFAULT_TIMEOUT = 60


def _run_with_timeout(fn, timeout: int, tool_name: str) -> ToolExecutionResult:
    """在线程池中执行工具函数，超时返回 error_result。用户等待期间不计入超时。"""
    if timeout <= 0:
        return fn()

    parent_timer = get_current_timer()

    def _wrapped():
        if parent_timer is not None:
            set_current_timer(parent_timer)
        return fn()

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(_wrapped)
        if parent_timer is None:
            try:
                return future.result(timeout=timeout)
            except concurrent.futures.TimeoutError:
                logger.error(f"工具 {tool_name} 执行超时 ({timeout}s){_obs_suffix()}")
                return error_result(f"工具 {tool_name} 执行超时（{timeout}秒）", tool_name=tool_name)

        start = time.monotonic()
        paused_at_start = parent_timer.paused_duration
        while True:
            try:
                return future.result(timeout=0.5)
            except concurrent.futures.TimeoutError:
                pass
            elapsed = time.monotonic() - start - (parent_timer.paused_duration - paused_at_start)
            if elapsed >= timeout:
                logger.error(f"工具 {tool_name} 执行超时 ({timeout}s){_obs_suffix()}")
                return error_result(f"工具 {tool_name} 执行超时（{timeout}秒）", tool_name=tool_name)


def _normalize_tool_result(result, tool_name: str) -> ToolExecutionResult:
    if isinstance(result, ToolExecutionResult):
        return result
    if result is None:
        return error_result("工具返回了空结果", tool_name=tool_name)
    if isinstance(result, dict):
        return success_result(content=result, tool_name=tool_name)
    return success_result(content=str(result), tool_name=tool_name)


def execute_tool(tool_name, arguments, agent_config=None, event_bus=None, user_role=None, caller="direct", session_id=None, run_id=None, cancel_event=None, parent_call_id=None, current_agent_name=None, tool_call_id=None):
    """执行指定工具。"""
    try:
        allowed, approval_error_result, approval_message = request_user_approval_if_needed(
            tool_name,
            arguments,
            agent_config=agent_config,
            event_bus=event_bus,
            user_role=user_role,
            caller=caller,
            session_id=session_id,
        )
        if not allowed:
            return approval_error_result

        from tools.permissions import get_tool_permission

        permission = get_tool_permission(tool_name)
        timeout = permission.timeout_seconds if permission else _DEFAULT_TIMEOUT
        handler = get_tool_handler(tool_name)

        if handler is not None:
            call_arguments = build_handler_call_arguments(
                handler,
                arguments,
                session_id=session_id,
                run_id=run_id,
                agent_config=agent_config,
                event_bus=event_bus,
                user_role=user_role,
                caller=caller,
                cancel_event=cancel_event,
                parent_call_id=parent_call_id,
                current_agent_name=current_agent_name,
                tool_call_id=tool_call_id,
            )
            if tool_name == "execute_code":
                result = handler(**call_arguments)
            else:
                result = _run_with_timeout(lambda: handler(**call_arguments), timeout, tool_name)
        elif _TOOL_REGISTRY.is_mcp_tool(tool_name):
            result = execute_mcp_tool(tool_name, arguments, session_id=session_id)
        else:
            result = error_result(f"未知的工具: {tool_name}", tool_name=tool_name)

        result = _normalize_tool_result(result, tool_name)
        if approval_message and result.success:
            result.metadata.setdefault("approval_message", approval_message)
        return result
    except Exception as error:
        logger.error(f"执行工具 {tool_name} 失败: {error}{_obs_suffix()}")
        import traceback

        traceback.print_exc()
        return error_result(str(error), tool_name=tool_name)


__all__ = ["execute_tool", "TOOL_HANDLERS"]
