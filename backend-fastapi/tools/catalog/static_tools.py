# -*- coding: utf-8 -*-
"""Static common tool definitions."""

from __future__ import annotations

from tools.tool_definition_builder import ToolContract, build_function_tools


STATIC_TOOL_CONTRACTS = [
    # 已迁移到 @tool() 装饰器的工具已从此处移除：
    # create_chart, create_map, create_bindmap, revise_visualization,
    # query_emergency_plan, assess_flood_risk, match_emergency_response,
    # create_risk_map, generate_report, execute_code
    # 它们的 Contract 在启动时通过 auto_discovery → register_extra_contracts 注入。
]


STATIC_TOOLS = build_function_tools(STATIC_TOOL_CONTRACTS)

