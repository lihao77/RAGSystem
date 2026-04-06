# -*- coding: utf-8 -*-
"""Shared runtime models for tool execution."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ToolExposureDecision:
    tool_name: str
    visible: bool
    source: str = "unknown"
    reason: str = ""
    derived_from: List[str] = field(default_factory=list)


@dataclass
class PermissionDecision:
    """
    三态权限决策，对应 Claude Code 的 allow / deny / ask 语义。

    execution_allowed=True  → allow（继续执行）
    execution_allowed=False → deny（直接拒绝，deny_reason 非空）
    requires_approval=True  → ask（需用户交互审批）
    """
    tool_name: str
    execution_allowed: bool = False
    requires_approval: bool = False
    deny_reason: str = ""
    # 审批通过后的附言（ask → approved 时由审批流程填入）
    approval_message: str = ""
    # 仅用于事件/日志观测，不参与执行决策
    risk_level: str = "low"
    permission_mode: Optional[str] = None
    resolved_from: List[str] = field(default_factory=list)

    @property
    def allowed(self) -> bool:
        return self.execution_allowed


@dataclass
class ToolUseContext:
    """
    工具调用的输入上下文袋（immutable-style）。

    仅承载调用发起时的环境信息，不在执行过程中 mutate 以累积状态。
    执行过程产生的状态（approval_message、handler_kind 等）通过返回值或
    局部变量传递，不写回本对象。
    """
    tool_name: str
    arguments: Dict[str, Any]
    agent_config: Any = None
    event_bus: Any = None
    user_role: Optional[str] = None
    caller: str = "direct"
    session_id: Optional[str] = None
    team_name: Optional[str] = None
    workspace_root: Optional[str] = None
    run_id: Optional[str] = None
    request_id: Optional[str] = None
    cancel_event: Any = None
    parent_call_id: Optional[str] = None
    current_agent_name: Optional[str] = None
    agent_display_name: Optional[str] = None
    tool_call_id: Optional[str] = None
    round: Optional[int] = None
    order: Optional[int] = None
    round_index: Optional[int] = None
    approved_external_paths: List[str] = field(default_factory=list)


__all__ = [
    "PermissionDecision",
    "ToolExposureDecision",
    "ToolUseContext",
]
