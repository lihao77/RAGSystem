# -*- coding: utf-8 -*-
"""工具系统统一 bootstrap 入口。"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_BOOTSTRAP_STATE: dict[str, Any] = {
    "decorated": {},
    "warnings": [],
}


def bootstrap_tool_system() -> dict[str, Any]:
    """统一完成装饰器工具发现、注册与一致性校验。"""
    from tools.consistency_check import check_tool_consistency
    from tools.permissions import _merge_decorated_permissions
    from tools.runtime.discovery import discover_decorated_tools
    from tools.runtime.registration import _merge_decorated_handlers
    from tools.tool_registry import get_tool_registry

    decorated = discover_decorated_tools()
    _merge_decorated_handlers()
    _merge_decorated_permissions()

    registry = get_tool_registry()
    contracts = [info["contract"] for info in decorated.values()]
    if contracts:
        registry.register_contracts(contracts)

    warnings = check_tool_consistency()
    _BOOTSTRAP_STATE["decorated"] = decorated
    _BOOTSTRAP_STATE["warnings"] = warnings

    logger.info(
        "工具系统 bootstrap 完成: decorated=%s warnings=%s",
        len(decorated),
        len(warnings),
    )
    return {
        "decorated": decorated,
        "contracts": contracts,
        "warnings": warnings,
    }


def get_bootstrap_state() -> dict[str, Any]:
    return dict(_BOOTSTRAP_STATE)


__all__ = ["bootstrap_tool_system", "get_bootstrap_state"]
