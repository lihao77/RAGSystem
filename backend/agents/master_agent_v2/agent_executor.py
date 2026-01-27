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
        执行指定的 Agent（非流式版本，用于兼容）

        Args:
            agent_name: Agent 名称（如 'qa_agent'）
            task: 要委托的任务描述
            context: 执行上下文
            context_hint: 可选的上下文提示

        Returns:
            标准化的工具响应格式
        """
        try:
            agent = self.orchestrator.agents.get(agent_name)
            if not agent:
                return self._error_response(f"Agent '{agent_name}' 不存在")

            enhanced_task = task
            if context_hint:
                enhanced_task = f"{task}\n\n【上下文提示】{context_hint}"

            self.logger.info(f"执行 Agent: {agent_name}")
            self.logger.info(f"任务: {enhanced_task[:200]}...")

            response = agent.execute(enhanced_task, context)

            if response.success:
                return {
                    "success": True,
                    "data": {
                        "results": response.content,
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

    def execute_agent_stream(
        self,
        agent_name: str,
        task: str,
        context: AgentContext,
        context_hint: Optional[str] = None
    ):
        """
        流式执行指定的 Agent（生成器版本）

        Args:
            agent_name: Agent 名称（如 'qa_agent'）
            task: 要委托的任务描述
            context: 执行上下文
            context_hint: 可选的上下文提示

        Yields:
            Agent 内部的执行事件（thought_structured, tool_start, tool_end 等）

        Returns (最后一个 yield):
            标准化的工具响应格式
        """
        try:
            # 1. 获取 Agent 实例
            agent = self.orchestrator.agents.get(agent_name)
            if not agent:
                yield self._error_response(f"Agent '{agent_name}' 不存在")
                return

            # 2. 增强任务描述
            enhanced_task = task
            if context_hint:
                enhanced_task = f"{task}\n\n【上下文提示】{context_hint}"

            self.logger.info(f"流式执行 Agent: {agent_name}")
            self.logger.info(f"任务: {enhanced_task[:200]}...")

            # 3. 检查 Agent 是否支持流式执行
            if not hasattr(agent, 'execute_stream'):
                # 降级到非流式执行
                self.logger.warning(f"Agent '{agent_name}' 不支持流式执行，使用非流式模式")
                result = self.execute_agent(agent_name, task, context, context_hint)
                yield result
                return

            # 4. 流式执行 Agent，透传所有事件
            final_content = ""
            for event in agent.execute_stream(enhanced_task, context):
                # 透传事件到上层（Master V2）
                yield event

                # 🎯 收集子 Agent 的最终答案
                if event.get('type') == 'final_answer':
                    final_content = event.get('content', '')

            # 5. 返回最终结果（标准化格式），包含完整的 final_answer 内容
            yield {
                "success": True,
                "data": {
                    "results": final_content,  # 🎯 这是子 Agent 的完整答案
                    "metadata": {
                        "agent_name": agent_name
                    },
                    "summary": self._generate_summary_from_content(final_content)
                }
            }

        except Exception as e:
            self.logger.error(f"流式执行 Agent '{agent_name}' 时出错: {e}", exc_info=True)
            yield self._error_response(str(e))

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

    def _generate_summary_from_content(self, content: str) -> str:
        """
        从内容生成摘要（用于流式执行）

        Args:
            content: 完整内容

        Returns:
            摘要文本（前200字符或完整内容）
        """
        if not content:
            return "Agent 执行完成"

        # 如果内容较短，直接返回
        if len(content) <= 200:
            return content

        # 否则返回前200字符 + 省略号
        return content[:200] + "..."

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
