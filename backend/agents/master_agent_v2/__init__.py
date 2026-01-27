# -*- coding: utf-8 -*-
"""
Master Agent V2 - 动态智能体编排系统

核心设计理念：
- Agent 不是预先编排的静态组件，而是可以动态调用的"工具"
- Master V2 通过 ReAct 模式，根据任务进展实时决定调用哪个 Agent
- 每次 Agent 调用都有明确的输入输出，完全可观察
"""

from .master_v2 import MasterAgentV2
from .agent_function_definitions import get_agent_tools
from .agent_executor import AgentExecutor

__all__ = [
    'MasterAgentV2',
    'get_agent_tools',
    'AgentExecutor'
]
