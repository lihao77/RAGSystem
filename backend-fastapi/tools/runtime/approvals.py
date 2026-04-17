# -*- coding: utf-8 -*-
"""Runtime helper for tool approval flow."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from execution.observability import format_observability_suffix
from tools.runtime.models import ToolUseContext
from tools.runtime.response_builder import error_result
from utils.timeout_pause import pause_current, resume_current

logger = logging.getLogger(__name__)


@dataclass
class ApprovalOutcome:
    allowed: bool
    error_result: object = None
    approval_message: str = ""
    approval_metadata: dict[str, Any] = field(default_factory=dict)
    approval_hook: dict[str, Any] = field(default_factory=dict)
    approved_external_paths: list[str] = field(default_factory=list)
    approval_reason_codes: list[str] = field(default_factory=list)
    approval_secondary_reasons: list[str] = field(default_factory=list)


def _candidate_external_paths_for_approval(context: ToolUseContext) -> list[str]:
    import re
    from pathlib import Path

    from core.path_resolution import is_path_within_managed_roots

    tool_name = (context.tool_name or "").strip()
    if context.caller != "direct":
        return []

    path_field = None
    operation = "read"
    if tool_name == "read_file":
        path_field = "file_path"
    elif tool_name in {"write_file", "edit_file"}:
        path_field = "file_path"
        operation = "write"
    elif tool_name == "execute_bash":
        path_field = "working_dir"
    else:
        return []

    raw_path = (context.arguments or {}).get(path_field)
    if raw_path is None:
        return []
    raw_path = str(raw_path).strip()
    if not raw_path:
        return []
    if raw_path.startswith("./data/"):
        return []

    windows_absolute = re.match(r'^[a-zA-Z]:[\\/]', raw_path)
    candidate = Path(raw_path.replace('/', '\\')) if windows_absolute else Path(raw_path)
    if not candidate.is_absolute():
        return []

    workspace_root = None
    if context.agent_config is not None:
        custom_params = getattr(context.agent_config, "custom_params", None) or {}
        workspace_root = custom_params.get("workspace_root")

    resolved_candidate = candidate.resolve()
    if is_path_within_managed_roots(
        resolved_candidate,
        session_id=(context.session_id or "").strip() or None,
        run_id=(context.run_id or "").strip() or None,
        caller="direct",
        operation=operation,
        workspace_root=workspace_root,
    ):
        return []
    return [str(resolved_candidate)]


def _build_approval_reason_payload(
    *,
    risk_reason: str,
    approved_external_paths: list[str],
    force_ask: bool,
) -> tuple[str, list[str], list[str]]:
    reason_codes: list[str] = []
    reasons: list[str] = []

    normalized_risk_reason = (risk_reason or "").strip()
    if normalized_risk_reason or force_ask:
        reason_codes.append("ask-risk")
        reasons.append(normalized_risk_reason or "当前策略要求人工审批")
    if approved_external_paths:
        reason_codes.append("ask-path")
        reasons.append("路径越界访问需要审批")

    if not reasons:
        return "", [], []
    primary_reason = reasons[-1]
    secondary_reasons = reasons[:-1]
    return primary_reason, secondary_reasons, reason_codes


def _run_hook_coroutine(coro):
    from tools.runtime.executor import _run_coroutine_sync

    return _run_coroutine_sync(coro)


def _filter_approval_hook_result(hook_result):
    """Defensive clamp for approval hook results."""
    if not hook_result:
        return hook_result

    from hooks.models import ApprovalHookResult

    return ApprovalHookResult(
        ui_message=getattr(hook_result, "ui_message", None),
        ui_metadata=dict(getattr(hook_result, "ui_metadata", {}) or {}),
        tags=list(getattr(hook_result, "tags", []) or []),
        metadata=dict(getattr(hook_result, "metadata", {}) or {}),
    )


def _approval_hook_payload(hook_result) -> dict[str, Any]:
    if not hook_result:
        return {}
    return {
        "ui_message": hook_result.ui_message,
        "ui_metadata": dict(hook_result.ui_metadata),
        "tags": list(hook_result.tags),
        "metadata": dict(hook_result.metadata),
    }


def _build_approval_metadata(
    *,
    reason: str,
    note: str = "",
    hook_result=None,
    approved_external_paths: list[str] | None = None,
    reason_codes: list[str] | None = None,
    secondary_reasons: list[str] | None = None,
) -> dict[str, Any]:
    metadata = {
        "reason": reason,
        "note": note or "",
    }
    if reason_codes:
        metadata["reason_codes"] = list(reason_codes)
    if secondary_reasons:
        metadata["secondary_reasons"] = list(secondary_reasons)
    if approved_external_paths:
        metadata["approved_external_paths"] = list(approved_external_paths)
    hook_payload = _approval_hook_payload(hook_result)
    if hook_payload:
        metadata["hook"] = hook_payload
    return metadata



def request_user_approval_if_needed(
    context: ToolUseContext,
    force_ask: bool = False,
) -> ApprovalOutcome:
    """检查工具权限并在需要时请求用户审批。"""
    from tools.permission_manager import get_effective_permission_policy, should_require_approval
    from tools.permissions import evaluate_tool_permission, get_tool_permission

    policy = get_effective_permission_policy(context.session_id)
    permission_mode = policy.mode.value
    skip_all_approvals = policy.skip_all_approvals
    approved_external_paths = _candidate_external_paths_for_approval(context)

    decision = evaluate_tool_permission(
        tool_name=context.tool_name,
        agent_config=context.agent_config,
        user_role=context.user_role,
        caller=context.caller,
    )
    if not decision.execution_allowed:
        logger.warning("工具权限检查失败: %s%s", decision.deny_reason, format_observability_suffix())
        return ApprovalOutcome(
            allowed=False,
            error_result=error_result(decision.deny_reason, tool_name=context.tool_name),
        )

    if skip_all_approvals:
        logger.debug("工具 %s 启用 skip_all_approvals，跳过审批%s", context.tool_name, format_observability_suffix())
        return ApprovalOutcome(allowed=True, approved_external_paths=approved_external_paths)

    permission = get_tool_permission(context.tool_name)
    if not permission:
        return ApprovalOutcome(allowed=True)

    requires, risk_reason = should_require_approval(context.tool_name, permission, context.arguments, session_id=context.session_id)
    reason, secondary_reasons, reason_codes = _build_approval_reason_payload(
        risk_reason=risk_reason,
        approved_external_paths=approved_external_paths,
        force_ask=force_ask,
    )
    if approved_external_paths:
        requires = True
    if not requires and not force_ask:
        if reason:
            logger.debug("工具 %s 审批跳过: %s%s", context.tool_name, reason, format_observability_suffix())
        return ApprovalOutcome(allowed=True)

    approval_required_hook = _run_approval_hook("approval.required", context, permission, reason)
    approval_hook_payload = _approval_hook_payload(approval_required_hook)

    logger.info("工具 %s 需要用户审批%s", context.tool_name, format_observability_suffix())

    if not context.event_bus:
        logger.warning("工具 %s 需要审批但无事件总线，拒绝执行%s", context.tool_name, format_observability_suffix())
        return ApprovalOutcome(
            allowed=False,
            error_result=error_result(
                f"工具 {context.tool_name} 需要用户授权，但当前上下文不支持审批",
                tool_name=context.tool_name,
                metadata={
                    "approval": _build_approval_metadata(
                        reason=reason,
                        hook_result=approval_required_hook,
                        approved_external_paths=approved_external_paths,
                        reason_codes=reason_codes,
                        secondary_reasons=secondary_reasons,
                    )
                },
            ),
            approval_hook=approval_hook_payload,
            approval_metadata=_build_approval_metadata(
                reason=reason,
                hook_result=approval_required_hook,
                approved_external_paths=approved_external_paths,
                reason_codes=reason_codes,
                secondary_reasons=secondary_reasons,
            ),
        )

    try:
        import uuid as _uuid
        from agents.events.bus import Event, EventType
        from agents.task_registry import get_task_registry

        approval_id = str(_uuid.uuid4())
        registry = get_task_registry()
        wait_evt = registry.add_pending_approval(context.session_id, approval_id) if context.session_id else None

        event_data = {
            "approval_id": approval_id,
            "tool_name": context.tool_name,
            "arguments": context.arguments,
            "risk_level": permission.risk_level.value,
            "description": permission.description,
            "permission_mode": permission_mode,
            "approval_reason": reason,
            "approval_reason_codes": reason_codes,
            "approval_secondary_reasons": secondary_reasons,
            "approval_hook": approval_hook_payload,
            "approved_external_paths": approved_external_paths,
        }
        context.event_bus.publish(Event(
            type=EventType.USER_APPROVAL_REQUIRED,
            session_id=context.session_id,
            data=event_data,
        ))
        logger.debug("已发布工具 %s 的审批请求事件 approval_id=%s%s", context.tool_name, approval_id, format_observability_suffix())

        if wait_evt is None:
            logger.warning("工具 %s 需要审批但缺少 session_id，拒绝执行%s", context.tool_name, format_observability_suffix())
            approval_metadata = _build_approval_metadata(
                reason=reason,
                hook_result=approval_required_hook,
                approved_external_paths=approved_external_paths,
                reason_codes=reason_codes,
                secondary_reasons=secondary_reasons,
            )
            return ApprovalOutcome(
                allowed=False,
                error_result=error_result(
                    f"工具 {context.tool_name} 需要用户授权，但当前上下文无法等待审批",
                    tool_name=context.tool_name,
                    metadata={"approval": approval_metadata},
                ),
                approval_hook=approval_hook_payload,
                approval_metadata=approval_metadata,
            )

        pause_current()
        try:
            wait_evt.wait()
        finally:
            resume_current()
        approved, approval_note = registry.get_approval_result(context.session_id, approval_id)

        if not approved:
            denied_hook = _run_approval_hook(
                "approval.denied",
                context,
                permission,
                reason,
                approved=False,
            )
            approval_metadata = _build_approval_metadata(
                reason=reason,
                note=approval_note,
                hook_result=denied_hook,
                approved_external_paths=approved_external_paths,
                reason_codes=reason_codes,
                secondary_reasons=secondary_reasons,
            )

            logger.info("工具 %s 审批被拒绝或任务已停止%s", context.tool_name, format_observability_suffix())
            deny_reason = approval_note if approval_note else "用户拒绝执行此操作"
            return ApprovalOutcome(
                allowed=False,
                error_result=error_result(
                    f"工具 {context.tool_name} 执行已被拒绝：{deny_reason}",
                    tool_name=context.tool_name,
                    metadata={"approval": approval_metadata},
                ),
                approval_hook=_approval_hook_payload(denied_hook),
                approval_metadata=approval_metadata,
            )

        resolved_hook = _run_approval_hook(
            "approval.resolved",
            context,
            permission,
            reason,
            approved=True,
            approval_note=approval_note,
        )
        approval_metadata = _build_approval_metadata(
            reason=reason,
            note=approval_note,
            hook_result=resolved_hook,
            approved_external_paths=approved_external_paths,
            reason_codes=reason_codes,
            secondary_reasons=secondary_reasons,
        )

        logger.debug("工具 %s 审批通过，继续执行%s", context.tool_name, format_observability_suffix())
        if approval_note:
            logger.debug("用户审批附言: %s%s", approval_note, format_observability_suffix())
        return ApprovalOutcome(
            allowed=True,
            approval_message=approval_note or "",
            approval_metadata=approval_metadata,
            approval_hook=_approval_hook_payload(resolved_hook),
            approved_external_paths=approved_external_paths,
            approval_reason_codes=reason_codes,
            approval_secondary_reasons=secondary_reasons,
        )
    except Exception as error:
        error_hook = _run_approval_hook("approval.error", context, permission, reason, error=error)
        approval_metadata = _build_approval_metadata(
            reason=reason,
            hook_result=error_hook,
            approved_external_paths=approved_external_paths,
            reason_codes=reason_codes,
            secondary_reasons=secondary_reasons,
        )

        logger.error("审批流程异常: %s%s", error, format_observability_suffix())
        return ApprovalOutcome(
            allowed=False,
            error_result=error_result(
                f"审批流程异常: {error}",
                tool_name=context.tool_name,
                metadata={"approval": approval_metadata},
            ),
            approval_hook=_approval_hook_payload(error_hook),
            approval_metadata=approval_metadata,
        )


def request_inline_approval(
    *,
    event_bus,
    session_id: str | None,
    tool_name: str,
    approval_type: str,
    arguments: dict,
    risk_level: str,
    description: str,
    registry_getter=None,
) -> tuple[bool, str]:
    """
    内联审批：供 bash_tool / code_sandbox 在工具内部自行发起用户审批。

    不走 ToolUseContext，直接使用 event_bus + session_id。

    Returns:
        (approved: bool, approval_note: str)
    """
    from tools.contracts.permissions import RiskLevel as _RL, ToolPermission
    from tools.permission_manager import get_effective_permission_policy, should_require_approval

    policy = get_effective_permission_policy(session_id)
    if policy.skip_all_approvals:
        logger.debug("内联审批跳过（skip_all_approvals）: %s", description)
        return True, ""

    _risk_map = {"low": _RL.LOW, "medium": _RL.MEDIUM, "high": _RL.HIGH}
    _perm = ToolPermission(
        tool_name=tool_name,
        risk_level=_risk_map.get(risk_level.lower(), _RL.HIGH),
        description=description,
    )
    needs, skip_reason = should_require_approval(tool_name, _perm, arguments, session_id=session_id)
    if not needs:
        logger.debug("内联审批跳过（%s）: %s", skip_reason or policy.mode.value, description)
        return True, ""

    if not event_bus:
        logger.warning("内联审批：无事件总线，拒绝执行")
        return False, "当前上下文不支持审批"
    if not session_id:
        logger.warning("内联审批：无 session_id，拒绝执行")
        return False, "当前上下文无法等待审批"

    try:
        import uuid as _uuid
        from agents.events.bus import Event, EventType
        if registry_getter is None:
            from agents.task_registry import get_task_registry as _default_registry_getter
            registry_getter = _default_registry_getter

        approval_id = str(_uuid.uuid4())
        registry = registry_getter()
        wait_evt = registry.add_pending_approval(session_id, approval_id)
        if wait_evt is None:
            return False, "当前上下文无法注册审批请求"

        event_payload = {
            "approval_id": approval_id,
            "approval_type": approval_type,
            "tool_name": tool_name,
            "arguments": arguments,
            "risk_level": risk_level,
            "description": description,
        }

        event_bus.publish(Event(
            type=EventType.USER_APPROVAL_REQUIRED,
            session_id=session_id,
            data=event_payload,
        ))

        try:
            pause_current()
            paused = True
        except Exception:
            paused = False
        try:
            wait_evt.wait()
        finally:
            if paused:
                try:
                    resume_current()
                except Exception:
                    pass

        approved, note = registry.get_approval_result(session_id, approval_id)
        return approved, note or ""
    except Exception as exc:
        logger.error("内联审批流程异常: %s", exc)
        return False, f"审批流程异常: {exc}"


def _run_approval_hook(
    event_name: str,
    context: ToolUseContext,
    permission,
    approval_reason: str,
    approved: bool = None,
    approval_note: str = None,
    error: Exception = None,
):
    """Run approval lifecycle hooks and return filtered result."""
    try:
        from hooks.config_loader import resolve_workspace_trust
        from hooks.executor import run_hooks
        from hooks.models import HookContext
        from tools.permission_manager import get_effective_permission_policy

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
            source="approval",
            tool_context=context,
            metadata={
                "approval_reason": approval_reason,
                "risk_level": permission.risk_level.value if permission else "unknown",
                "permission_mode": get_effective_permission_policy(context.session_id).mode.value,
                "approved": approved,
                "approval_note": approval_note,
                "error": str(error) if error else None,
            },
        )

        return _filter_approval_hook_result(_run_hook_coroutine(run_hooks(hook_context)))

    except Exception as e:
        logger.warning("Approval hook execution failed for %s: %s", event_name, e)
        return None
