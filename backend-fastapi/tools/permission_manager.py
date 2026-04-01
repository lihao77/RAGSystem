"""Multi-layer permission manager with mode-based approval control."""

from __future__ import annotations

import fnmatch
import logging
from pathlib import PurePosixPath

from tools.contracts.permission_modes import AutoAcceptPattern, PermissionMode, PermissionPolicy
from tools.contracts.permissions import RiskLevel, ToolPermission

logger = logging.getLogger(__name__)

_current_policy = PermissionPolicy()


# ── policy CRUD ──────────────────────────────────────────────

def get_permission_policy() -> PermissionPolicy:
    return _current_policy


def set_permission_policy(policy: PermissionPolicy) -> None:
    global _current_policy
    _current_policy = policy


def set_permission_mode(mode: PermissionMode) -> None:
    _current_policy.mode = mode


# ── auto-accept patterns ────────────────────────────────────

def add_auto_accept_pattern(pattern_type: str, pattern_value: str, description: str = "") -> None:
    _current_policy.auto_accept_patterns.append(
        AutoAcceptPattern(pattern_type=pattern_type, pattern_value=pattern_value, description=description)
    )


def remove_auto_accept_pattern(pattern_type: str, pattern_value: str) -> bool:
    before = len(_current_policy.auto_accept_patterns)
    _current_policy.auto_accept_patterns = [
        p for p in _current_policy.auto_accept_patterns
        if not (p.pattern_type == pattern_type and p.pattern_value == pattern_value)
    ]
    return len(_current_policy.auto_accept_patterns) < before


def clear_auto_accept_patterns() -> None:
    _current_policy.auto_accept_patterns = []


# ── core decision ────────────────────────────────────────────

def _match_auto_accept(tool_name: str, permission: ToolPermission, arguments: dict) -> tuple[bool, str]:
    """检查自动接受规则，返回 (matched, reason)。"""
    for pat in _current_policy.auto_accept_patterns:
        if pat.pattern_type == "tool_name":
            if fnmatch.fnmatch(tool_name, pat.pattern_value):
                return True, f"工具名匹配规则 '{pat.pattern_value}' 自动接受"
        elif pat.pattern_type == "file_pattern":
            file_path = arguments.get("file_path", "")
            if file_path and fnmatch.fnmatch(file_path, pat.pattern_value):
                return True, f"文件路径匹配规则 '{pat.pattern_value}' 自动接受"
        elif pat.pattern_type == "risk_level":
            if permission.risk_level.value == pat.pattern_value:
                return True, f"风险等级匹配规则 '{pat.pattern_value}' 自动接受"
    return False, ""


def should_require_approval(tool_name: str, permission: ToolPermission, arguments: dict) -> tuple[bool, str]:
    """
    根据当前权限策略判断是否需要用户审批。
    审批由 auto-accept 规则 + risk_level + PermissionMode 共同决定；
    auto-accept 的优先级高于模式判断。

    Returns:
        (needs_approval: bool, reason: str)
    """
    mode = _current_policy.mode

    if mode == PermissionMode.DANGEROUSLY_SKIP_PERMISSIONS:
        return False, "dangerously_skip_permissions 模式，跳过审批"

    matched, reason = _match_auto_accept(tool_name, permission, arguments)
    if matched:
        return False, reason

    if mode == PermissionMode.STRICT:
        return True, f"严格模式：{permission.risk_level.value} 风险工具需要审批"

    if mode == PermissionMode.STANDARD:
        if permission.risk_level in (RiskLevel.MEDIUM, RiskLevel.HIGH):
            return True, f"标准模式：{permission.risk_level.value} 风险工具需要审批"
        return False, ""

    if mode == PermissionMode.RELAXED:
        if permission.risk_level == RiskLevel.HIGH:
            return True, "宽松模式：高风险工具需要审批"
        return False, ""

    return False, ""
