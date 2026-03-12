# -*- coding: utf-8 -*-
"""agents/tools — Agent 内置工具定义导出入口。"""

from tools.catalog.builtin_tools import (
    BUILTIN_TOOL_NAMES,
    REQUEST_USER_INPUT_TOOL,
    get_builtin_tools_for_master,
    get_builtin_tools_for_react,
)
from tools.catalog.skill_tools import (
    SKILLS_SYSTEM_TOOLS,
    SKILLS_TOOL_NAMES,
)

__all__ = [
    REQUEST_USER_INPUT_TOOL,
    SKILLS_SYSTEM_TOOLS,
    get_builtin_tools_for_react,
    get_builtin_tools_for_master,
    BUILTIN_TOOL_NAMES,
    SKILLS_TOOL_NAMES,
    "REQUEST_USER_INPUT_TOOL",
    "SKILLS_SYSTEM_TOOLS",
    "get_builtin_tools_for_react",
    "get_builtin_tools_for_master",
    "BUILTIN_TOOL_NAMES",
    "SKILLS_TOOL_NAMES",
]
