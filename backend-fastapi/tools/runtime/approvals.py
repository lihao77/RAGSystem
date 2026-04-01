# -*- coding: utf-8 -*-
"""Runtime helper for tool approval flow."""

from __future__ import annotations

import logging

from execution.observability import format_observability_for_log, get_current_execution_observability_fields
from tools.runtime.response_builder import error_result
from utils.timeout_pause import pause_current, resume_current

logger = logging.getLogger(__name__)


def _obs_suffix() -> str:
    suffix = format_observability_for_log(get_current_execution_observability_fields())
    return f" [{suffix}]" if suffix else ""


def request_user_approval_if_needed(tool_name, arguments, *, agent_config=None, event_bus=None, user_role=None, caller="direct", session_id=None):
    from tools.permissions import check_tool_permission, get_tool_permission

    allowed, error_msg = check_tool_permission(
        tool_name=tool_name,
        agent_config=agent_config,
        user_role=user_role,
        caller=caller,
    )
    if not allowed:
        logger.warning(f"工具权限检查失败: {error_msg}{_obs_suffix()}")
        return False, error_result(error_msg, tool_name=tool_name), ""

    approval_message = ""
    permission = get_tool_permission(tool_name)
    if not permission:
        return True, None, approval_message

    from tools.permission_manager import get_permission_policy, should_require_approval
    requires, reason = should_require_approval(tool_name, permission, arguments)
    if not requires:
        if reason:
            logger.info(f"工具 {tool_name} 审批跳过: {reason}{_obs_suffix()}")
        return True, None, approval_message

    permission_mode = get_permission_policy().mode.value

    logger.info(f"工具 {tool_name} 需要用户审批{_obs_suffix()}")
    if not event_bus:
        logger.warning(f"工具 {tool_name} 需要审批但无事件总线，拒绝执行{_obs_suffix()}")
        return False, error_result(
            f"工具 {tool_name} 需要用户授权，但当前上下文不支持审批",
            tool_name=tool_name,
        ), ""

    try:
        import uuid as _uuid
        from agents.events import Event, EventType
        from agents.task_registry import get_task_registry

        approval_id = str(_uuid.uuid4())
        registry = get_task_registry()
        wait_evt = registry.add_pending_approval(session_id, approval_id) if session_id else None

        event_bus.publish(Event(
            type=EventType.USER_APPROVAL_REQUIRED,
            session_id=session_id,
            data={
                "approval_id": approval_id,
                "tool_name": tool_name,
                "arguments": arguments,
                "risk_level": permission.risk_level.value,
                "description": permission.description,
                "permission_mode": permission_mode,
                "approval_reason": reason,
            }
        ))
        logger.info(f"已发布工具 {tool_name} 的审批请求事件 approval_id={approval_id}{_obs_suffix()}")

        if wait_evt is None:
            logger.warning(f"工具 {tool_name} 需要审批但缺少 session_id，拒绝执行{_obs_suffix()}")
            return False, error_result(
                f"工具 {tool_name} 需要用户授权，但当前上下文无法等待审批",
                tool_name=tool_name,
            ), ""

        pause_current()
        try:
            wait_evt.wait()
        finally:
            resume_current()
        approved, approval_note = registry.get_approval_result(session_id, approval_id)
        if not approved:
            logger.info(f"工具 {tool_name} 审批被拒绝或任务已停止{_obs_suffix()}")
            deny_reason = approval_note if approval_note else "用户拒绝执行此操作"
            return False, error_result(
                f"工具 {tool_name} 执行已被拒绝：{deny_reason}",
                tool_name=tool_name,
            ), ""

        logger.info(f"工具 {tool_name} 审批通过，继续执行{_obs_suffix()}")
        if approval_note:
            approval_message = approval_note
            logger.info(f"用户审批附言: {approval_note}{_obs_suffix()}")
        return True, None, approval_message
    except Exception as error:
        logger.error(f"审批流程异常: {error}{_obs_suffix()}")
        return False, error_result(f"审批流程异常: {error}", tool_name=tool_name), ""
