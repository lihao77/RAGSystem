# -*- coding: utf-8 -*-
"""
Agent Executor - 执行 Agent 调用

类似 tool_executor.py 的设计，但用于执行 Agent 而非 Tool
"""

import logging
from typing import Dict, Any, Optional
from ..base import AgentContext, AgentResponse

logger = logging.getLogger(__name__)


class AgentExecutor:
    """
    Agent 执行器

    职责：
    1. 将 Master V2 的 Agent 调用请求路由到具体的 Agent
    2. 处理 Agent 的输入输出格式
    3. 错误处理和日志记录
    """

    def __init__(self, orchestrator):
        """
        初始化 Agent 执行器

        Args:
            orchestrator: AgentOrchestrator 实例，用于访问所有已注册的 Agent
        """
        self.orchestrator = orchestrator
        self.logger = logging.getLogger(self.__class__.__name__)

    def execute_agent(
        self,
        agent_name: str,
        task: str,
        context: AgentContext,
        context_hint: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        执行指定的 Agent

        Args:
            agent_name: Agent 名称（如 'qa_agent'）
            task: 要委托的任务描述
            context: 执行上下文
            context_hint: 可选的上下文提示

        Returns:
            标准化的工具响应格式:
            {
                "success": True/False,
                "data": {
                    "results": agent_response.content,  # Agent 的回答
                    "metadata": {...},
                    "summary": "..."
                },
                "error": "..." (if failed)
            }
        """
        try:
            # 1. 从 orchestrator 获取 Agent 实例
            agent = self.orchestrator.agents.get(agent_name)
            if not agent:
                return self._error_response(f"Agent '{agent_name}' 不存在")

            # 2. 增强任务描述（如果有 context_hint）
            enhanced_task = task
            if context_hint:
                enhanced_task = f"{task}\n\n【上下文提示】{context_hint}"

            self.logger.info(f"执行 Agent: {agent_name}")
            self.logger.info(f"任务: {enhanced_task[:200]}...")

            # 3. 调用 Agent 执行任务
            # 注意：这里直接调用 agent.execute，不通过 orchestrator.execute
            # 因为我们已经在 Master V2 的上下文中，不需要重新路由
            response = agent.execute(enhanced_task, context)

            # 4. 转换为标准化工具响应格式
            if response.success:
                return {
                    "success": True,
                    "data": {
                        "results": response.content,  # Agent 的完整回答
                        "metadata": {
                            "agent_name": agent_name,
                            "execution_time": response.execution_time,
                            "tool_calls": len(response.tool_calls) if response.tool_calls else 0
                        },
                        "summary": self._generate_summary(response)
                    }
                }
            else:
                return self._error_response(
                    f"Agent '{agent_name}' 执行失败: {response.error}"
                )

        except Exception as e:
            self.logger.error(f"执行 Agent '{agent_name}' 时出错: {e}", exc_info=True)
            return self._error_response(str(e))

    def _generate_summary(self, response: AgentResponse) -> str:
        """
        生成 Agent 响应的摘要

        Args:
            response: AgentResponse 对象

        Returns:
            摘要文本
        """
        summary_parts = []

        # 基础信息
        summary_parts.append(f"Agent 执行成功")

        # 执行时间
        if response.execution_time:
            summary_parts.append(f"，耗时 {response.execution_time:.2f}s")

        # 工具调用次数
        if response.tool_calls:
            summary_parts.append(f"，调用了 {len(response.tool_calls)} 个工具")

        # 内容长度
        if response.content:
            content_len = len(str(response.content))
            if content_len > 500:
                summary_parts.append(f"，返回 {content_len} 字符")

        return "".join(summary_parts)

    def _error_response(self, error_msg: str) -> Dict[str, Any]:
        """
        构建错误响应

        Args:
            error_msg: 错误信息

        Returns:
            错误响应字典
        """
        return {
            "success": False,
            "error": error_msg
        }


def parse_agent_invocation(tool_name: str) -> Optional[str]:
    """
    从工具名称中解析出 Agent 名称

    工具名称格式: "invoke_agent_<agent_name>"
    例如: "invoke_agent_qa_agent" -> "qa_agent"

    Args:
        tool_name: 工具名称

    Returns:
        Agent 名称，如果格式不匹配则返回 None
    """
    prefix = "invoke_agent_"
    if tool_name.startswith(prefix):
        return tool_name[len(prefix):]
    return None
