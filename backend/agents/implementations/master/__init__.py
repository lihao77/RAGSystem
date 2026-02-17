# -*- coding: utf-8 -*-
"""
Master 智能体实现（统一入口编排器）
"""

from .agent import MasterAgentV2
from .function_definitions import get_agent_tools
from .executor import AgentExecutor, parse_agent_invocation

__all__ = [
    'MasterAgentV2',
    'get_agent_tools',
    'AgentExecutor',
    'parse_agent_invocation',
]
