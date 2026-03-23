# -*- coding: utf-8 -*-
"""agents/tools — Agent 内置工具定义导出入口。"""

from tools.tool_registry import get_tool_registry

_TOOL_REGISTRY = get_tool_registry()


def get_builtin_tools():
    return _TOOL_REGISTRY.get_builtin_tools()


__all__ = [
    'get_builtin_tools',
]
