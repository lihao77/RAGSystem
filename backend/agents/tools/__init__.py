# -*- coding: utf-8 -*-
"""
agents/tools — Agent 内置工具定义

与 tools/function_definitions.py（领域工具，可配置）的区别：
- 这里存放 Agent 框架级工具（默认注入，不出现在 enabled_tools 配置中）
- 领域工具（知识图谱、分析等）仍在 tools/function_definitions.py
"""

from .builtin import (
    REQUEST_USER_INPUT_TOOL,
    SKILLS_SYSTEM_TOOLS,
    get_builtin_tools_for_react,
    get_builtin_tools_for_master,
    BUILTIN_TOOL_NAMES,
    SKILLS_TOOL_NAMES,
)

__all__ = [
    'REQUEST_USER_INPUT_TOOL',
    'SKILLS_SYSTEM_TOOLS',
    'get_builtin_tools_for_react',
    'get_builtin_tools_for_master',
    'BUILTIN_TOOL_NAMES',
    'SKILLS_TOOL_NAMES',
]
