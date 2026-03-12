# -*- coding: utf-8 -*-
"""OrchestratorAgent 执行入口。"""

from agents.core import AgentContext, AgentResponse


def execute_orchestrator(agent, task: str, context: AgentContext) -> AgentResponse:
    """复用统一的 ReAct 主循环。"""
    return agent._execute_react_task(task, context)
