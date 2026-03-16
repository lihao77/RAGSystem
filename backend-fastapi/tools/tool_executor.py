# -*- coding: utf-8 -*-
"""
工具执行公共入口。

该模块作为 `tools.tool_executor_modules` 的稳定对外门面，
供 Agent 运行时和沙箱代码统一导入。
"""

from tools.tool_executor_modules import execute_tool

__all__ = [
    'execute_tool',
]
