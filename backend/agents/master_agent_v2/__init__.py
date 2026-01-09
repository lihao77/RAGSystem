# -*- coding: utf-8 -*-
"""
MasterAgent V2 - 增强的主协调智能体

这是一个独立的模块，包含 MasterAgent V2 的所有组件。

核心组件：
- master_agent_v2.py: 主协调智能体
- enhanced_context.py: 增强的上下文管理
- execution_plan.py: 执行计划抽象
- failure_handler.py: 失败处理器
- hybrid_scheduler.py: 混合调度器

使用方法：
    from agents.master_agent_v2 import MasterAgentV2

    agent = MasterAgentV2(llm_adapter, orchestrator)
    response = agent.execute(task, context)
"""

from .master_agent_v2 import MasterAgentV2
from .enhanced_context import EnhancedAgentContext
from .execution_plan import (
    ExecutionPlan,
    ExecutionMode,
    DirectAnswerPlan,
    StaticExecutionPlan,
    HybridExecutionPlan,
    TaskNode,
    Stage,
    FallbackStrategy,
    create_execution_plan
)
from .failure_handler import FailureHandler
from .hybrid_scheduler import HybridScheduler

__version__ = '2.0.0'

__all__ = [
    'MasterAgentV2',
    'EnhancedAgentContext',
    'ExecutionPlan',
    'ExecutionMode',
    'DirectAnswerPlan',
    'StaticExecutionPlan',
    'HybridExecutionPlan',
    'TaskNode',
    'Stage',
    'FallbackStrategy',
    'create_execution_plan',
    'FailureHandler',
    'HybridScheduler',
]
