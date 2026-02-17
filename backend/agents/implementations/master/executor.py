# -*- coding: utf-8 -*-
"""
Agent Executor - 执行 Agent 调用

类似 tool_executor.py 的设计，但用于执行 Agent 而非 Tool
"""

import logging
from typing import Dict, Any, Optional

from agents.core import AgentContext, AgentResponse

logger = logging.getLogger(__name__)


class AgentExecutor:
    """
    Agent 执行器：将 Master 的 Agent 调用请求路由到具体 Agent，处理输入输出格式，错误处理与日志。
    """

    def __init__(self, orchestrator):
        self.orchestrator = orchestrator
        self.logger = logging.getLogger(self.__class__.__name__)

    def execute_agent(
        self,
        agent_name: str,
        task: str,
        context: AgentContext,
        context_hint: Optional[str] = None
    ) -> Dict[str, Any]:
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
        try:
            agent = self.orchestrator.agents.get(agent_name)
            if not agent:
                yield self._error_response(f"Agent '{agent_name}' 不存在")
                return

            enhanced_task = task
            if context_hint:
                enhanced_task = f"{task}\n\n【上下文提示】{context_hint}"

            self.logger.info(f"流式执行 Agent: {agent_name}")
            self.logger.info(f"任务: {enhanced_task[:200]}...")

            if not hasattr(agent, 'execute_stream'):
                self.logger.warning(f"Agent '{agent_name}' 不支持流式执行，使用非流式模式")
                result = self.execute_agent(agent_name, task, context, context_hint)
                yield result
                return

            final_content = ""
            for event in agent.execute_stream(enhanced_task, context):
                yield event
                if event.get('type') == 'final_answer':
                    final_content = event.get('content', '')

            yield {
                "success": True,
                "data": {
                    "results": final_content,
                    "metadata": {"agent_name": agent_name},
                    "summary": self._generate_summary_from_content(final_content)
                }
            }

        except Exception as e:
            self.logger.error(f"流式执行 Agent '{agent_name}' 时出错: {e}", exc_info=True)
            yield self._error_response(str(e))

    def _generate_summary(self, response: AgentResponse) -> str:
        summary_parts = ["Agent 执行成功"]
        if response.execution_time:
            summary_parts.append(f"，耗时 {response.execution_time:.2f}s")
        if response.tool_calls:
            summary_parts.append(f"，调用了 {len(response.tool_calls)} 个工具")
        if response.content:
            content_len = len(str(response.content))
            if content_len > 500:
                summary_parts.append(f"，返回 {content_len} 字符")
        return "".join(summary_parts)

    def _generate_summary_from_content(self, content: str) -> str:
        if not content:
            return "Agent 执行完成"
        if len(content) <= 200:
            return content
        return content[:200] + "..."

    def _error_response(self, error_msg: str) -> Dict[str, Any]:
        return {"success": False, "error": error_msg}


def parse_agent_invocation(tool_name: str) -> Optional[str]:
    """从工具名称解析 Agent 名称，格式: invoke_agent_<agent_name>"""
    prefix = "invoke_agent_"
    if tool_name.startswith(prefix):
        return tool_name[len(prefix):]
    return None
