# -*- coding: utf-8 -*-
"""工具注册一致性校验：对比装饰器注册与手动注册的一致性。"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def check_tool_consistency() -> list[str]:
    """
    对比装饰器注册的工具与 TOOL_HANDLERS / TOOL_PERMISSIONS 的一致性。

    Returns:
        警告列表，空列表表示一致性校验通过
    """
    from tools.decorators import get_decorated_tools
    from tools.runtime.registration import TOOL_HANDLERS
    from tools.permissions import TOOL_PERMISSIONS

    warnings: list[str] = []
    decorated = get_decorated_tools()

    for tool_name, tool_info in decorated.items():
        # 检查 handler 一致性
        if tool_name in TOOL_HANDLERS:
            decorated_handler = tool_info["handler"]
            registered_handler = TOOL_HANDLERS[tool_name]
            # 比较底层函数（装饰器 wrapper 的 __wrapped__）
            unwrapped = getattr(registered_handler, "__wrapped__", registered_handler)
            decorated_unwrapped = getattr(decorated_handler, "__wrapped__", decorated_handler)
            if unwrapped is not decorated_unwrapped and unwrapped is not decorated_handler:
                warnings.append(
                    f"工具 '{tool_name}' 的 handler 不一致: "
                    f"装饰器={decorated_handler.__module__}.{decorated_handler.__qualname__}, "
                    f"手动注册={registered_handler.__module__}.{registered_handler.__qualname__}"
                )

        # 检查权限配置一致性
        if tool_name in TOOL_PERMISSIONS:
            dec_perm = tool_info["permission"]
            reg_perm = TOOL_PERMISSIONS[tool_name]
            if dec_perm.risk_level != reg_perm.risk_level:
                warnings.append(
                    f"工具 '{tool_name}' 的 risk_level 不一致: "
                    f"装饰器={dec_perm.risk_level}, 手动注册={reg_perm.risk_level}"
                )

    # 记录日志
    if warnings:
        for w in warnings:
            logger.warning("[工具一致性校验] %s", w)
    else:
        logger.info("[工具一致性校验] 通过，共 %d 个装饰器工具", len(decorated))

    return warnings
