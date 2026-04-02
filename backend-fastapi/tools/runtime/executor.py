# -*- coding: utf-8 -*-
"""Canonical runtime entrypoint for tool execution."""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import time
from collections.abc import Coroutine
from typing import Any

from tools.contracts.result_models import ToolExecutionResult
from tools.runtime.approvals import _obs_suffix, request_user_approval_if_needed
from tools.runtime.dispatcher import build_handler_call_arguments, execute_mcp_tool, get_tool_handler
from tools.runtime.models import ToolUseContext
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


def _run_coroutine_sync(coro: Coroutine[Any, Any, Any]):
    """Run a coroutine from sync code, even if another event loop is already running."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(lambda: asyncio.run(coro))
        return future.result()


def _filter_hook_result_for_phase(hook_result, *, phase: str):
    if not hook_result:
        return hook_result

    from hooks.models import (
        ApprovalHookResult,
        ContextHookResult,
        DecisionHookResult,
        ErrorHookResult,
        HookResult,
        ObservationHookResult,
    )

    filtered = HookResult(
        continue_execution=hook_result.continue_execution,
        block_execution=hook_result.block_execution,
        block_reason=hook_result.block_reason,
    )

    if phase in {"before_permission", "after_permission"}:
        decision_result = DecisionHookResult(
            continue_execution=filtered.continue_execution,
            block_execution=filtered.block_execution,
            block_reason=filtered.block_reason,
            permission_decision=getattr(hook_result, "permission_decision", None),
            ui_message=getattr(hook_result, "ui_message", None),
            ui_metadata=dict(getattr(hook_result, "ui_metadata", {}) or {}),
            tags=list(getattr(hook_result, "tags", []) or []),
            metadata=dict(getattr(hook_result, "metadata", {}) or {}),
            broadcast_progress=getattr(hook_result, "broadcast_progress", None),
        )
        return decision_result

    if phase == "before_execute":
        return ContextHookResult(
            continue_execution=filtered.continue_execution,
            block_execution=filtered.block_execution,
            block_reason=filtered.block_reason,
            additional_context=list(getattr(hook_result, "additional_context", []) or []),
            ui_message=getattr(hook_result, "ui_message", None),
            ui_metadata=dict(getattr(hook_result, "ui_metadata", {}) or {}),
            tags=list(getattr(hook_result, "tags", []) or []),
            metadata=dict(getattr(hook_result, "metadata", {}) or {}),
            broadcast_progress=getattr(hook_result, "broadcast_progress", None),
        )

    if phase == "after_execute":
        return ObservationHookResult(
            continue_execution=filtered.continue_execution,
            block_execution=filtered.block_execution,
            block_reason=filtered.block_reason,
            additional_context=list(getattr(hook_result, "additional_context", []) or []),
            ui_message=getattr(hook_result, "ui_message", None),
            ui_metadata=dict(getattr(hook_result, "ui_metadata", {}) or {}),
            tags=list(getattr(hook_result, "tags", []) or []),
            metadata=dict(getattr(hook_result, "metadata", {}) or {}),
            broadcast_progress=getattr(hook_result, "broadcast_progress", None),
        )

    if phase == "on_error":
        return ErrorHookResult(
            continue_execution=filtered.continue_execution,
            block_execution=filtered.block_execution,
            block_reason=filtered.block_reason,
            tags=list(getattr(hook_result, "tags", []) or []),
            metadata=dict(getattr(hook_result, "metadata", {}) or {}),
            broadcast_progress=getattr(hook_result, "broadcast_progress", None),
        )

    if phase.startswith("approval"):
        return ApprovalHookResult(
            continue_execution=filtered.continue_execution,
            block_execution=filtered.block_execution,
            block_reason=filtered.block_reason,
            ui_message=getattr(hook_result, "ui_message", None),
            ui_metadata=dict(getattr(hook_result, "ui_metadata", {}) or {}),
            tags=list(getattr(hook_result, "tags", []) or []),
            metadata=dict(getattr(hook_result, "metadata", {}) or {}),
        )

    return filtered


def _merge_hook_data(result: ToolExecutionResult, hook_result, *, phase: str) -> None:
    if not hook_result:
        return

    if getattr(hook_result, "additional_context", None):
        result.metadata.setdefault("hook_additional_context", {})[phase] = list(hook_result.additional_context)
    if getattr(hook_result, "ui_message", None):
        result.metadata.setdefault("hook_message", {})[phase] = hook_result.ui_message
    if getattr(hook_result, "ui_metadata", None):
        if hook_result.ui_metadata:
            result.metadata.setdefault("hook_metadata", {})[phase] = dict(hook_result.ui_metadata)
    if getattr(hook_result, "tags", None):
        phase_tags = result.metadata.setdefault("hook_tags", {}).setdefault(phase, [])
        for tag in hook_result.tags:
            if tag not in phase_tags:
                phase_tags.append(tag)
    if getattr(hook_result, "metadata", None):
        if hook_result.metadata:
            result.metadata.setdefault("hook_phase_metadata", {})[phase] = dict(hook_result.metadata)


def _merge_approval_metadata(result: ToolExecutionResult, approval_metadata: dict | None, approval_message: str = "") -> None:
    if not approval_metadata and not approval_message:
        return

    existing = dict(result.metadata.get("approval", {}))
    if approval_metadata:
        existing.update(approval_metadata)
    if approval_message and not existing.get("note"):
        existing["note"] = approval_message
    result.metadata["approval"] = existing


def execute_tool(
    tool_name,
    arguments,
    agent_config=None,
    event_bus=None,
    user_role=None,
    caller="direct",
    session_id=None,
    run_id=None,
    cancel_event=None,
    parent_call_id=None,
    current_agent_name=None,
    tool_call_id=None,
    round=None,
    order=None,
    round_index=None,
    request_id=None,
    agent_display_name=None,
) -> ToolExecutionResult:
    """执行指定工具。"""
    context = ToolUseContext(
        tool_name=tool_name,
        arguments=dict(arguments or {}),
        agent_config=agent_config,
        event_bus=event_bus,
        user_role=user_role,
        caller=caller,
        session_id=session_id,
        run_id=run_id,
        request_id=request_id,
        cancel_event=cancel_event,
        parent_call_id=parent_call_id,
        current_agent_name=current_agent_name,
        agent_display_name=agent_display_name or current_agent_name,
        tool_call_id=tool_call_id,
        round=round,
        order=order,
        round_index=round_index,
    )

    try:
        hook_result = _filter_hook_result_for_phase(
            _run_hooks_sync("tool.before_permission", context),
            phase="before_permission",
        )
        if hook_result and hook_result.block_execution:
            return error_result(hook_result.block_reason, tool_name=tool_name)

        approval_outcome = request_user_approval_if_needed(context)
        if not approval_outcome.allowed:
            return approval_outcome.error_result

        from tools.permissions import evaluate_tool_permission, get_tool_permission

        permission = get_tool_permission(tool_name)
        permission_decision = evaluate_tool_permission(
            tool_name=tool_name,
            agent_config=agent_config,
            user_role=user_role,
            caller=caller,
        )

        hook_result = _filter_hook_result_for_phase(
            _run_hooks_sync("tool.after_permission", context, permission_decision=permission_decision),
            phase="after_permission",
        )
        if hook_result:
            if hook_result.block_execution:
                return error_result(hook_result.block_reason, tool_name=tool_name)
            if hook_result.permission_decision == "deny":
                return error_result("Hook denied tool execution", tool_name=tool_name)
            elif hook_result.permission_decision == "ask":
                approval_outcome = request_user_approval_if_needed(context, force_ask=True)
                if not approval_outcome.allowed:
                    return approval_outcome.error_result

        timeout = permission.timeout_seconds if permission else _DEFAULT_TIMEOUT

        before_execute_hook_result = _filter_hook_result_for_phase(
            _run_hooks_sync("tool.before_execute", context),
            phase="before_execute",
        )
        if before_execute_hook_result and before_execute_hook_result.block_execution:
            return error_result(before_execute_hook_result.block_reason, tool_name=tool_name)

        handler = get_tool_handler(tool_name)

        if handler is not None:
            call_arguments = build_handler_call_arguments(handler, context)
            if tool_name == "execute_code":
                result = handler(**call_arguments)
            else:
                result = _run_with_timeout(lambda: handler(**call_arguments), timeout, tool_name)
        elif _TOOL_REGISTRY.is_mcp_tool(tool_name):
            result = execute_mcp_tool(context)
        else:
            result = error_result(f"未知的工具: {tool_name}", tool_name=tool_name)

        result = _normalize_tool_result(result, tool_name)
        _merge_hook_data(result, before_execute_hook_result, phase="before_execute")

        hook_result = _filter_hook_result_for_phase(
            _run_hooks_sync("tool.after_execute", context, result=result),
            phase="after_execute",
        )
        if hook_result:
            _merge_hook_data(result, hook_result, phase="after_execute")

        _merge_approval_metadata(result, approval_outcome.approval_metadata, approval_outcome.approval_message)
        if approval_outcome.approval_message:
            result.metadata.setdefault("approval_message", approval_outcome.approval_message)
        return result

    except Exception as error:
        hook_result = _filter_hook_result_for_phase(
            _run_hooks_sync("tool.on_error", context, error=error),
            phase="on_error",
        )

        logger.error(f"执行工具 {tool_name} 失败: {error}{_obs_suffix()}")
        import traceback
        traceback.print_exc()
        result = error_result(str(error), tool_name=tool_name)
        _merge_approval_metadata(result, approval_outcome.approval_metadata, approval_outcome.approval_message)
        if approval_outcome.approval_message:
            result.metadata.setdefault("approval_message", approval_outcome.approval_message)
        _merge_hook_data(result, hook_result, phase="on_error")
        return result


def _run_hooks_sync(event_name: str, context: ToolUseContext, **kwargs) -> Any:
    """Run hooks synchronously in the tool execution flow."""
    try:
        from hooks.config_loader import resolve_workspace_trust
        from hooks.executor import run_hooks
        from hooks.models import HookContext
        from tools.permission_manager import get_permission_policy
        from tools.permissions import get_tool_permission

        permission = get_tool_permission(context.tool_name)
        permission_risk_level = permission.risk_level.value if permission else None
        permission_mode = get_permission_policy().mode.value
        workspace_root = None
        if context.agent_config is not None:
            custom_params = getattr(context.agent_config, "custom_params", None) or {}
            workspace_root = custom_params.get("workspace_root")

        hook_context = HookContext(
            event_name=event_name,
            phase=event_name.split(".")[-1],
            timestamp=time.time(),
            session_id=context.session_id,
            run_id=context.run_id,
            request_id=context.request_id,
            agent_name=context.current_agent_name,
            agent_display_name=context.agent_display_name,
            caller=context.caller,
            user_role=context.user_role,
            tool_name=context.tool_name,
            tool_call_id=context.tool_call_id,
            parent_call_id=context.parent_call_id,
            round=context.round,
            order=context.order,
            round_index=context.round_index,
            workspace_trust=resolve_workspace_trust(workspace_root),
            source="runtime",
            tool_context=context,
            permission_decision=kwargs.get("permission_decision"),
            input_snapshot=dict(context.arguments),
            result_snapshot=_build_result_snapshot(kwargs.get("result")),
            error_snapshot=_build_error_snapshot(kwargs.get("error")),
            metadata={
                "risk_level": permission_risk_level,
                "permission_mode": permission_mode,
            },
        )

        return _run_coroutine_sync(run_hooks(hook_context))

    except Exception as e:
        logger.warning(f"Hook execution failed for {event_name}: {e}")
        return None


def _build_result_snapshot(result: ToolExecutionResult | None) -> dict:
    """Build a snapshot of tool execution result for hooks."""
    if result is None:
        return {}

    first_artifact = result.artifacts[0] if result.artifacts else None
    artifact_path = first_artifact.path if first_artifact else None

    return {
        "success": result.success,
        "preview": str(result.content)[:500] if result.content else "",
        "has_artifact": bool(result.artifacts),
        "artifact_path": artifact_path,
        "artifact_count": len(result.artifacts),
        "output_type": result.output_type,
        "summary": result.summary,
    }


def _build_error_snapshot(error: Exception | None) -> dict:
    """Build a snapshot of execution error for hooks."""
    if error is None:
        return {}

    return {
        "type": type(error).__name__,
        "message": str(error),
    }


__all__ = ["execute_tool", "TOOL_HANDLERS"]
