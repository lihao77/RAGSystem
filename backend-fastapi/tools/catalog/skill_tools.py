# -*- coding: utf-8 -*-
"""Skill system tool definitions."""

from __future__ import annotations

from tools.tool_definition_builder import ToolContract, build_function_tools


SKILL_TOOL_CONTRACTS = [
    # 已迁移到 @tool() 装饰器（tool_executor_modules/skill_tools.py）。
    # Contract 在启动时通过 auto_discovery → register_extra_contracts 注入。
]


SKILLS_SYSTEM_TOOLS = build_function_tools(SKILL_TOOL_CONTRACTS)
SKILLS_TOOL_NAMES = {tool["function"]["name"] for tool in SKILLS_SYSTEM_TOOLS}
