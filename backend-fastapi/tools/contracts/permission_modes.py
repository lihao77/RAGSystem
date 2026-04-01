"""Permission mode models for multi-layer permission control."""

from enum import Enum
from typing import List

from pydantic import BaseModel


class PermissionMode(str, Enum):
    """权限模式"""
    STRICT = "strict"                                       # 全部风险工具需审批；命中 auto-accept 规则时仍可跳过
    STANDARD = "standard"                                   # 默认：MEDIUM/HIGH 风险需审批；命中 auto-accept 规则时可跳过
    RELAXED = "relaxed"                                     # 仅 HIGH 风险需审批；命中 auto-accept 规则时可跳过
    DANGEROUSLY_SKIP_PERMISSIONS = "dangerously_skip_permissions"  # 跳过审批


class AutoAcceptPattern(BaseModel):
    """自动接受规则"""
    pattern_type: str   # "tool_name" | "file_pattern" | "risk_level"
    pattern_value: str
    description: str = ""


class PermissionPolicy(BaseModel):
    """权限策略"""
    mode: PermissionMode = PermissionMode.STANDARD
    auto_accept_patterns: List[AutoAcceptPattern] = []
    audit_all_checks: bool = False
    approval_timeout: int = 300
