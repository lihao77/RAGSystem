# -*- coding: utf-8 -*-
"""
通用智能体 - 可通过配置文件定义的智能体

支持通过配置文件定义智能体行为，无需编写代码
"""

import logging
from typing import Optional, Dict, Any, List
from .base import BaseAgent, AgentContext, AgentResponse
from tools.function_definitions import get_tool_definitions
from tools.tool_executor import execute_tool

logger = logging.getLogger(__name__)


class GenericAgent(BaseAgent):
    """
    通用智能体

    可以通过配置文件定义的智能体，无需编写代码。
    适用于标准的查询、分析任务。

    配置示例:
    ```yaml
    agents:
      custom_agent:
        type: "generic"  # 使用通用模板
        agent_name: "custom_agent"
        display_name: "自定义智能体"
        description: "通过配置定义的智能体"
        enabled: true
        llm:
          temperature: 0.3
          max_tokens: 4096
        tools:
          enabled_tools:
            - query_kg
            - semantic_search
        behavior:
          system_prompt: "你是一个专门做XX的智能体..."
          max_rounds: 10
          auto_execute_tools: true
    ```
    """

    def __init__(
        self,
        agent_name: str,
        display_name: str = None,
        description: str = None,
        llm_adapter = None,
        agent_config = None,
        system_config = None,
        behavior_config: Optional[Dict[str, Any]] = None
    ):
        """
        初始化通用智能体

        Args:
            agent_name: 智能体名称
            display_name: 显示名称
            description: 描述
            llm_adapter: LLM 适配器
            agent_config: 智能体配置
            system_config: 系统配置
            behavior_config: 行为配置 (system_prompt, max_rounds 等)
        """
        super().__init__(
            name=agent_name,
            description=description or display_name or agent_name,
            capabilities=['query', 'tool_calling'],
            llm_adapter=llm_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.display_name = display_name or agent_name
        self.behavior_config = behavior_config or {}

        # 行为配置
        self.system_prompt = self.behavior_config.get(
            'system_prompt',
            f"你是 {self.display_name}，{self.description}"
        )
        self.max_rounds = self.behavior_config.get('max_rounds', 10)
        self.auto_execute_tools = self.behavior_config.get('auto_execute_tools', True)

        # 加载工具定义
        all_tools = get_tool_definitions()

        # 根据配置过滤工具
        if agent_config and agent_config.tools and agent_config.tools.enabled_tools:
            enabled_tools = agent_config.tools.enabled_tools
            self.tools = [
                tool for tool in all_tools
                if tool.get('function', {}).get('name') in enabled_tools
            ]
            logger.info(f"{self.name} 已根据配置过滤工具，启用: {enabled_tools}")
        else:
            self.tools = all_tools
            logger.info(f"{self.name} 启用所有工具")

        logger.info(f"GenericAgent '{self.name}' 初始化完成，可用工具数量: {len(self.tools)}")

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        通用智能体默认可以处理所有任务
        可以在 behavior_config 中配置 task_patterns 来限制
        """
        # 如果配置了任务模式，则进行匹配
        task_patterns = self.behavior_config.get('task_patterns', [])
        if task_patterns:
            import re
            for pattern in task_patterns:
                if re.search(pattern, task, re.IGNORECASE):
                    return True
            return False

        # 默认可以处理所有任务
        return True

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """
        执行任务

        通用智能体的执行流程：
        1. 使用 system_prompt 初始化对话
        2. 调用 LLM 进行推理
        3. 如果 LLM 返回工具调用，执行工具
        4. 重复 2-3 直到得到最终答案或达到最大轮数
        """
        import time
        start_time = time.time()

        try:
            # 构建消息历史
            messages = []

            # 添加系统提示
            if self.system_prompt:
                messages.append({
                    "role": "system",
                    "content": self.system_prompt
                })

            # 添加历史消息
            history = context.get_history(limit=5)
            for msg in history:
                messages.append({
                    "role": msg['role'],
                    "content": msg['content']
                })

            # 添加当前任务
            messages.append({
                "role": "user",
                "content": task
            })

            # 获取 LLM 配置
            llm_config = self.get_llm_config()

            # 多轮对话循环
            rounds = 0
            tool_calls_history = []

            while rounds < self.max_rounds:
                rounds += 1
                self.logger.info(f"执行第 {rounds} 轮推理")

                # 调用 LLM
                response = self.llm_adapter.chat_completion(
                    messages=messages,
                    tools=self.tools if self.auto_execute_tools else None,
                    provider=llm_config.get('provider'),
                    model=llm_config.get('model_name'),
                    temperature=llm_config.get('temperature', 0.3),
                    max_tokens=llm_config.get('max_tokens'),
                    timeout=llm_config.get('timeout'),
                    max_retries=llm_config.get('retry_attempts')
                )

                if response.error:
                    return AgentResponse(
                        success=False,
                        content="",
                        error=f"LLM 调用失败: {response.error}",
                        agent_name=self.name,
                        execution_time=time.time() - start_time
                    )

                # 检查是否有工具调用
                if response.tool_calls and self.auto_execute_tools:
                    # 执行工具调用
                    tool_results = []
                    for tool_call in response.tool_calls:
                        tool_name = tool_call.get('name')
                        tool_args = tool_call.get('arguments', {})

                        self.logger.info(f"执行工具: {tool_name}, 参数: {tool_args}")

                        # 执行工具
                        result = execute_tool(tool_name, tool_args)
                        tool_results.append({
                            'tool_name': tool_name,
                            'arguments': tool_args,
                            'result': result
                        })

                        # 记录工具调用
                        tool_calls_history.append({
                            'tool_name': tool_name,
                            'arguments': tool_args,
                            'result': result
                        })

                    # 将工具结果添加到消息中
                    messages.append({
                        "role": "assistant",
                        "content": response.content,
                        "tool_calls": response.tool_calls
                    })

                    for tool_result in tool_results:
                        messages.append({
                            "role": "tool",
                            "content": str(tool_result['result']),
                            "tool_name": tool_result['tool_name']
                        })

                    # 继续下一轮
                    continue
                else:
                    # 没有工具调用，返回最终答案
                    return AgentResponse(
                        success=True,
                        content=response.content,
                        agent_name=self.name,
                        execution_time=time.time() - start_time,
                        tool_calls=tool_calls_history,
                        metadata={
                            'rounds': rounds,
                            'final_response': True
                        }
                    )

            # 达到最大轮数
            return AgentResponse(
                success=True,
                content=f"已达到最大轮数 ({self.max_rounds})，当前答案：{response.content}",
                agent_name=self.name,
                execution_time=time.time() - start_time,
                tool_calls=tool_calls_history,
                metadata={
                    'rounds': rounds,
                    'max_rounds_reached': True
                }
            )

        except Exception as e:
            self.logger.error(f"执行任务失败: {e}", exc_info=True)
            return AgentResponse(
                success=False,
                content="",
                error=str(e),
                agent_name=self.name,
                execution_time=time.time() - start_time
            )
