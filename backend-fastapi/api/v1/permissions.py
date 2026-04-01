# -*- coding: utf-8 -*-
"""权限策略管理 API。"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from tools.contracts.permission_modes import AutoAcceptPattern, PermissionMode, PermissionPolicy
from tools.permission_manager import (
    add_auto_accept_pattern,
    clear_auto_accept_patterns,
    get_permission_policy,
    remove_auto_accept_pattern,
    set_permission_mode,
    set_permission_policy,
)

router = APIRouter()


class SetModeRequest(BaseModel):
    mode: PermissionMode


class PatternRequest(BaseModel):
    pattern_type: str
    pattern_value: str
    description: str = ""


@router.get("/policy")
def get_policy():
    """获取当前权限策略。"""
    policy = get_permission_policy()
    return policy.model_dump()


@router.put("/policy")
def update_policy(policy: PermissionPolicy):
    """整体替换权限策略。"""
    set_permission_policy(policy)
    return get_permission_policy().model_dump()


@router.put("/mode")
def update_mode(req: SetModeRequest):
    """仅切换权限模式。"""
    set_permission_mode(req.mode)
    return {"mode": get_permission_policy().mode.value}


@router.post("/auto-accept")
def add_pattern(req: PatternRequest):
    """添加自动接受规则。"""
    add_auto_accept_pattern(req.pattern_type, req.pattern_value, req.description)
    return get_permission_policy().model_dump()


@router.delete("/auto-accept")
def delete_pattern(req: PatternRequest):
    """删除自动接受规则。"""
    removed = remove_auto_accept_pattern(req.pattern_type, req.pattern_value)
    return {"removed": removed, **get_permission_policy().model_dump()}


@router.delete("/auto-accept/all")
def clear_patterns():
    """清空所有自动接受规则。"""
    clear_auto_accept_patterns()
    return get_permission_policy().model_dump()
