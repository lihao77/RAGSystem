# -*- coding: utf-8 -*-
"""工具装饰器：将 ToolContract + ToolPermission + handler 合并到一处定义。"""

from __future__ import annotations

import functools
from typing import Any, Callable

from tools.tool_definition_builder import ToolContract
from tools.permissions import ToolPermission, RiskLevel

# 全局注册表：装饰器注册的工具
_DECORATED_TOOLS: dict[str, dict[str, Any]] = {}


def tool(
    name: str | None = None,
    description: str = "",
    parameters: dict[str, Any] | None = None,
    risk_level: RiskLevel = RiskLevel.LOW,
    requires_approval: bool = False,
    timeout_seconds: int = 60,
    allowed_callers: list[str] | None = None,
    allowed_roles: list[str] | None = None,
    returns: dict[str, Any] | None = None,
    usage_contract: list[str] | None = None,
    examples: list[dict[str, Any]] | None = None,
    tags: list[str] | None = None,
    source: str = "decorator",
) -> Callable:
    """
    工具注册装饰器。

    用法::

        @tool(
            name="generate_report",
            description="生成标准格式应急报告",
            parameters={...},
            risk_level=RiskLevel.LOW,
            timeout_seconds=120,
        )
        async def generate_report(arguments, **kwargs):
            ...
    """
    _allowed_callers = allowed_callers or ["direct"]

    def decorator(fn: Callable) -> Callable:
        tool_name = name or fn.__name__

        contract = ToolContract(
            name=tool_name,
            description=description,
            parameters=parameters or {"type": "object", "properties": {}},
            allowed_callers=_allowed_callers,
            returns=returns,
            usage_contract=usage_contract or [],
            examples=examples or [],
            tags=tags or [],
            source=source,
        )

        permission = ToolPermission(
            tool_name=tool_name,
            risk_level=risk_level,
            requires_approval=requires_approval,
            description=description,
            allowed_callers=_allowed_callers,
            allowed_roles=allowed_roles or [],
            timeout_seconds=timeout_seconds,
        )

        _DECORATED_TOOLS[tool_name] = {
            "handler": fn,
            "contract": contract,
            "permission": permission,
        }

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            return fn(*args, **kwargs)

        wrapper._tool_name = tool_name
        return wrapper

    return decorator


def get_decorated_tools() -> dict[str, dict[str, Any]]:
    """返回所有通过 @tool() 装饰器注册的工具。"""
    return _DECORATED_TOOLS