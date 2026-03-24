# -*- coding: utf-8 -*-
"""Runtime helper for decorated tool registration."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_HANDLERS: dict[str, object] = {}


def _merge_decorated_handlers() -> None:
    """将装饰器注册的工具合并到 TOOL_HANDLERS（不覆盖已有手动注册）。"""
    from tools.decorators import get_decorated_tools

    decorated = get_decorated_tools()
    for tool_name, tool_info in decorated.items():
        if tool_name not in TOOL_HANDLERS:
            TOOL_HANDLERS[tool_name] = tool_info["handler"]
            logger.info("合并装饰器工具 handler: %s", tool_name)
