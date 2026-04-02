# -*- coding: utf-8 -*-
"""Runtime helper for tool approval flow."""

from __future__ import annotations

import logging
import time

from execution.observability import format_observability_for_log, get_current_execution_observability_fields
from tools.runtime.models import ToolUseContext
from tools.runtime.response_builder import error_result
from utils.timeout_pause import pause_current, resume_current

logger = logging.getLogger(__name__)


def _run_hook_coroutine(coro):
    from tools.runtime.executor import _run_coroutine_sync

    return _run_coroutine_sync(coro)


def _filter_approval_hook_result(hook_result):
    if not hook_result:
        return hook_result

    from hooks.models import HookResult

    filtered = HookResult()
    filtered.ui_message = hook_result.ui_message
    filtered.ui_metadata = dict(hook_result.ui_metadata)
    filtered.tags = list(hook_result.tags)
    filtered.metadata = dict(hook_result.metadata)
    return filtered


def _obs_suffix() -> str:
    suffix = format_observability_for_log(get_current_execution_observability_fields())
    return f" [{suffix}]" if suffix else ""


def request_user_approval_if_needed(
    context: ToolUseContext,
    force_ask: bool = False,
) -> tuple[bool, object, str]:
    """
    检查工具权限并在需要时请求用户审批。

    Args:
        context: Tool use context
        force_ask: Force approval request (used by hooks)

    Returns:
        (allowed, error_result_or_none, approval_message)
    """
    from tools.permission_manager import get_permission_policy, should_require_approval
    from tools.permissions import evaluate_tool_permission, get_tool_permission

    permission_mode = get_permission_policy().mode.value

    decision = evaluate_tool_permission(
        tool_name=context.tool_name,
        agent_config=context.agent_config,
        user_role=context.user_role,
        caller=context.caller,
    )
    if not decision.execution_allowed:
        logger.warning(f"工具权限检查失败: {decision.deny_reason}{_obs_suffix()}")
        return False, error_result(decision.deny_reason, tool_name=context.tool_name), ""

    approval_message = ""
    permission = get_tool_permission(context.tool_name)
    if not permission:
        return True, None, approval_message

    requires, reason = should_require_approval(context.tool_name, permission, context.arguments)
    if not requires and not force_ask:
        if reason:
            logger.info(f"工具 {context.tool_name} 审批跳过: {reason}{_obs_suffix()}")
        return True, None, approval_message

    # Hook: approval.required
    _run_approval_hook("approval.required", context, permission, reason)

    logger.info(f"工具 {context.tool_name} 需要用户审批{_obs_suffix()}")
    if not context.event_bus:
        logger.warning(f"工具 {context.tool_name} 需要审批但无事件总线，拒绝执行{_obs_suffix()}")
        return False, error_result(
            f"工具 {context.tool_name} 需要用户授权，但当前上下文不支持审批",
            tool_name=context.tool_name,
        ), ""

    try:
        import uuid as _uuid
        from agents.events import Event, EventType
        from agents.task_registry import get_task_registry

        approval_id = str(_uuid.uuid4())
        registry = get_task_registry()
        wait_evt = registry.add_pending_approval(context.session_id, approval_id) if context.session_id else None

        context.event_bus.publish(Event(
            type=EventType.USER_APPROVAL_REQUIRED,
            session_id=context.session_id,
            data={
                "approval_id": approval_id,
                "tool_name": context.tool_name,
                "arguments": context.arguments,
                "risk_level": permission.risk_level.value,
                "description": permission.description,
                "permission_mode": permission_mode,
                "approval_reason": reason,
            }
        ))
        logger.info(f"已发布工具 {context.tool_name} 的审批请求事件 approval_id={approval_id}{_obs_suffix()}")

        if wait_evt is None:
            logger.warning(f"工具 {context.tool_name} 需要审批但缺少 session_id，拒绝执行{_obs_suffix()}")
            return False, error_result(
                f"工具 {context.tool_name} 需要用户授权，但当前上下文无法等待审批",
                tool_name=context.tool_name,
            ), ""

        pause_current()
        try:
            wait_evt.wait()
        finally:
            resume_current()
        approved, approval_note = registry.get_approval_result(context.session_id, approval_id)

        if not approved:
            # Hook: approval.denied
            _run_approval_hook("approval.denied", context, permission, reason, approved=False)

            logger.info(f"工具 {context.tool_name} 审批被拒绝或任务已停止{_obs_suffix()}")
            deny_reason = approval_note if approval_note else "用户拒绝执行此操作"
            return False, error_result(
                f"工具 {context.tool_name} 执行已被拒绝：{deny_reason}",
                tool_name=context.tool_name,
            ), ""

        # Hook: approval.resolved
        _run_approval_hook("approval.resolved", context, permission, reason, approved=True, approval_note=approval_note)

        logger.info(f"工具 {context.tool_name} 审批通过，继续执行{_obs_suffix()}")
        if approval_note:
            approval_message = approval_note
            logger.info(f"用户审批附言: {approval_note}{_obs_suffix()}")
        return True, None, approval_message
    except Exception as error:
        # Hook: approval.error
        _run_approval_hook("approval.error", context, permission, reason, error=error)

        logger.error(f"审批流程异常: {error}{_obs_suffix()}")
        return False, error_result(f"审批流程异常: {error}", tool_name=context.tool_name), ""


def _run_approval_hook(
    event_name: str,
    context: ToolUseContext,
    permission,
    approval_reason: str,
    approved: bool = None,
    approval_note: str = None,
    error: Exception = None,
) -> None:
    """Run approval lifecycle hooks.

    Args:
        event_name: Hook event name (approval.required/resolved/denied/error)
        context: Tool use context
        permission: Tool permission object
        approval_reason: Reason for approval requirement
        approved: Whether approval was granted (for resolved/denied)
        approval_note: User's approval note
        error: Exception if approval failed
    """
    try:
        from hooks.executor import run_hooks
        from hooks.models import HookContext
        from tools.permission_manager import get_permission_policy

        # Build hook context
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
            workspace_trust="trusted",
            source="approval",
            tool_context=context,
            metadata={
                "approval_reason": approval_reason,
                "risk_level": permission.risk_level.value if permission else "unknown",
                "permission_mode": get_permission_policy().mode.value,
                "approved": approved,
                "approval_note": approval_note,
                "error": str(error) if error else None,
            },
        )

        _filter_approval_hook_result(_run_hook_coroutine(run_hooks(hook_context)))

    except Exception as e:
        logger.warning(f"Approval hook execution failed for {event_name}: {e}")
