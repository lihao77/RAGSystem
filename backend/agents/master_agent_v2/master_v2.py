# -*- coding: utf-8 -*-
"""
Master Agent V2 - 动态智能体编排器

设计理念：将 Agent 当作工具，通过 ReAct 模式动态调用
"""

import logging
import json
import time
from typing import Dict, List, Any, Optional, Generator

from ..base import BaseAgent, AgentContext, AgentResponse
from ..context_manager import ContextManager, ContextConfig, ObservationFormatter
from .agent_function_definitions import get_agent_tools
from .agent_executor import AgentExecutor, parse_agent_invocation

logger = logging.getLogger(__name__)


class MasterAgentV2(BaseAgent):
    """
    Master Agent V2 - 动态智能体编排器

    核心特性：
    1. **Agent 作为工具**: 将其他 Agent 视为可调用的工具
    2. **ReAct 模式**: 使用推理-行动循环，动态决定调用哪个 Agent
    3. **完全可观察**: 每次 Agent 调用都有明确的输入输出
    4. **灵活编排**: 不依赖预设的 DAG，根据任务进展实时决策

    与 Master V1 的区别：
    - V1: 预先分析任务 → 生成 DAG → 按计划执行 → 整合结果
    - V2: 分析任务 → 调用 Agent → 观察结果 → 决定下一步 → ... → 生成答案

    优势：
    - 更灵活：可以根据中间结果调整策略
    - 更自主：Master 自己决定何时调用哪个 Agent
    - 更可靠：每一步都可观察，易于调试
    """

    # 输出格式定义（与 ReAct Agent 类似）
    RESPONSE_SCHEMA = {
        "type": "object",
        "properties": {
            "thought": {
                "type": "string",
                "description": "当前的思考过程和决策理由"
            },
            "actions": {
                "type": "array",
                "description": "要执行的 Agent 调用列表（可以一次调用多个独立的 Agent）",
                "items": {
                    "type": "object",
                    "properties": {
                        "tool": {"type": "string", "description": "Agent 工具名称（如 invoke_agent_qa_agent）"},
                        "arguments": {"type": "object", "description": "Agent 参数"}
                    }
                }
            },
            "final_answer": {
                "type": "string",
                "description": "如果已经有足够信息，提供最终答案；否则为null"
            }
        },
        "required": ["thought"]
    }

    def __init__(
        self,
        orchestrator,
        llm_adapter=None,
        agent_config=None,
        system_config=None
    ):
        """
        初始化 Master Agent V2

        Args:
            orchestrator: AgentOrchestrator 实例（用于访问其他 Agent）
            llm_adapter: LLM 适配器
            agent_config: 智能体配置
            system_config: 系统配置
        """
        super().__init__(
            name='master_agent_v2',
            description='动态智能体编排器，将 Agent 当作工具使用',
            capabilities=[
                'dynamic_planning',
                'agent_coordination',
                'adaptive_execution'
            ],
            llm_adapter=llm_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.orchestrator = orchestrator
        self.agent_executor = AgentExecutor(orchestrator)

        # 从配置获取行为参数
        behavior_config = agent_config.custom_params.get('behavior', {}) if agent_config else {}
        self.max_rounds = behavior_config.get('max_rounds', 15)  # V2 可能需要更多轮次
        self.base_prompt = behavior_config.get('system_prompt', '')

        # 获取模型的上下文限制
        llm_config = self.get_llm_config()
        model_max_tokens = llm_config.get('max_tokens', 4096)
        context_token_budget = int(model_max_tokens * 0.6)
        max_context_tokens = behavior_config.get('max_context_tokens', context_token_budget)

        # 初始化上下文管理器
        context_config = ContextConfig(
            max_history_turns=behavior_config.get('max_history_turns', 15),
            max_tokens=max_context_tokens,
            compression_strategy=behavior_config.get('compression_strategy', 'sliding_window')
        )
        self.context_manager = ContextManager(context_config)

        # 初始化观察结果格式化器
        self.observation_formatter = ObservationFormatter(
            data_save_dir=behavior_config.get('data_save_dir', './static/temp_data')
        )

        # 注意：不在初始化时生成 Agent 工具列表
        # 因为此时其他 Agent 可能还未注册到 orchestrator
        # 延迟到 _get_available_agent_tools() 方法中动态获取

        logger.info(
            f"MasterAgentV2 初始化完成，"
            f"模型 max_tokens: {model_max_tokens}, "
            f"上下文预算: {max_context_tokens} tokens"
        )

    def _get_agent_display_name(self, agent_name: str) -> str:
        """
        获取 Agent 的友好显示名称

        Args:
            agent_name: Agent 技术名称（如 'kgqa_agent'）

        Returns:
            str: 友好显示名称（如 '知识图谱问答智能体'）
        """
        # 尝试从 orchestrator 获取智能体实例
        agent = self.orchestrator.agents.get(agent_name)

        # 如果智能体存在且有配置，从配置中获取 display_name
        if agent and hasattr(agent, 'agent_config') and agent.agent_config:
            display_name = agent.agent_config.display_name
            if display_name:
                return display_name

        # 降级：直接返回技术名称
        return agent_name

    def _format_agent_result_summary(self, result: Dict[str, Any]) -> str:
        """
        格式化 Agent 执行结果为摘要文本

        Args:
            result: Agent 执行结果

        Returns:
            str: 结果摘要
        """
        if not result.get('success'):
            error = result.get('error', '未知错误')
            return f"执行失败: {error}"

        # 提取结果内容
        data = result.get('data', {})
        results = data.get('results', '')
        summary = data.get('summary', '')

        # 优先使用 summary
        if summary:
            return summary

        # 否则从 results 中提取摘要
        if isinstance(results, str):
            # 文本结果：截取前200字符
            return results[:200] + "..." if len(results) > 200 else results
        elif isinstance(results, dict):
            # 字典结果：显示键数量
            return f"返回了 {len(results)} 个字段"
        elif isinstance(results, list):
            # 列表结果：显示元素数量
            return f"返回了 {len(results)} 条记录"
        else:
            return "执行成功"

    def _get_available_agent_tools(self):
        """
        动态获取可用的 Agent 工具列表

        延迟到执行时获取，确保其他 Agent 已经注册
        """
        return get_agent_tools(self.orchestrator.agents)

    def _build_system_prompt(self) -> str:
        """构建系统提示词"""
        # 动态获取 Agent 工具列表（延迟获取，确保其他 Agent 已注册）
        available_agent_tools = self._get_available_agent_tools()

        # 构建 Agent 工具说明
        agent_tools_desc_lines = []
        for tool in available_agent_tools:
            func = tool['function']
            name = func['name']
            desc = func['description']

            agent_tools_desc_lines.append(f"\n### {name}")
            agent_tools_desc_lines.append(f"{desc}")

        agent_tools_desc = "\n".join(agent_tools_desc_lines)

        # 构造示例（使用第一个可用的 Agent 工具）
        example_tool_name = available_agent_tools[0]['function']['name'] if available_agent_tools else "invoke_agent_qa_agent"

        parallel_example = f"""```json
{{
  "thought": "分析用户任务，决定调用哪个 Agent 来处理",
  "actions": [
    {{
      "tool": "{example_tool_name}",
      "arguments": {{
        "task": "要委托给 Agent 的具体任务描述",
        "context_hint": "可选的上下文提示"
      }}
    }}
  ],
  "final_answer": null
}}
```"""

        return f"""{self.base_prompt}

## 可用的 Agent 工具

你可以调用以下 Agent 来完成不同类型的任务：

{agent_tools_desc}

## 工作方式（ReAct 模式）

你是一个智能体编排器，通过**推理-行动-观察**的循环来完成复杂任务：

1. **Thought（推理）**: 分析当前情况，决定下一步调用哪个 Agent
2. **Action（行动）**: 调用选定的 Agent 工具
3. **Observation（观察）**: 观察 Agent 的执行结果
4. **重复**: 根据观察结果决定是否需要调用其他 Agent，或生成最终答案

**输出格式**:

```json
{{
  "thought": "我的思考过程...",
  "actions": [
    {{
      "tool": "Agent工具名称",
      "arguments": {{"task": "具体任务描述", "context_hint": "上下文提示"}}
    }}
  ],
  "final_answer": null  // 如果还没有最终答案
}}
```

**重要规则：**

1. **只能使用上面"可用的 Agent 工具"部分列出的工具**
2. **thought 必须简洁**（不超过100字）
   - 说明为什么选择这个 Agent
   - 说明期望 Agent 完成什么任务
3. **可以一次调用多个 Agent**（如果它们之间没有依赖）
4. **链式调用**：如果 Agent B 依赖 Agent A 的结果，可以在同一轮中链式调用
   - 使用占位符 {{result_1}} 引用第1个 Agent 的结果
   - 使用占位符 {{result_2}} 引用第2个 Agent 的结果
   - 以此类推
5. **当你有足够信息回答用户问题时，在 final_answer 中给出答案**
6. **如果 Agent 返回错误，在下一轮 thought 中分析原因并调整策略**

**决策指南：**

- 如果任务涉及知识图谱查询、数据分析 → 调用 invoke_agent_qa_agent
- 如果需要执行预定义的工作流 → 调用 invoke_agent_workflow_agent
- 如果任务很简单（如问候、闲聊） → 直接生成 final_answer，不调用 Agent
- 如果需要多个步骤 → 按顺序调用相应的 Agent，每次观察结果后再决定下一步

**示例**:
{parallel_example}

只返回 JSON，不要有其他内容。
"""

    def stream_execute(self, task: str, context: AgentContext):
        """
        流式执行任务（生成器版本）

        兼容接口名称（与 Master V1 保持一致）

        Yields:
            事件字典
        """
        return self.execute_stream(task, context)

    def execute_stream(self, task: str, context: AgentContext):
        """
        流式执行任务（生成器版本）

        Yields:
            事件字典
        """
        start_time = time.time()

        try:
            # 初始化对话历史
            messages = [
                {"role": "system", "content": self._build_system_prompt()},
                {"role": "user", "content": task}
            ]

            rounds = 0
            agent_calls_history = []

            while rounds < self.max_rounds:
                rounds += 1
                self.logger.info(f"[MasterV2] 第 {rounds} 轮推理")

                # 应用上下文管理
                managed_messages = self.context_manager.manage_messages(
                    messages,
                    system_prompt=self._build_system_prompt()
                )
                self.logger.info(f"[MasterV2] {self.context_manager.format_context_summary(managed_messages)}")

                # 获取 LLM 配置
                llm_config = self.get_llm_config()

                # 调用 LLM（使用 JSON mode）
                response = self.llm_adapter.chat_completion(
                    messages=managed_messages,
                    provider=llm_config.get('provider'),
                    model=llm_config.get('model_name'),
                    temperature=llm_config.get('temperature', 0.3),
                    max_tokens=llm_config.get('max_tokens'),
                    response_format={"type": "json_object"}
                )

                if response.error:
                    yield {
                        "type": "error",
                        "content": f"LLM 调用失败: {response.error}"
                    }
                    return

                # 解析 JSON 响应
                try:
                    output = json.loads(response.content)
                except json.JSONDecodeError as e:
                    self.logger.error(f"JSON 解析失败: {e}")
                    yield {
                        "type": "error",
                        "content": f"LLM 返回无效的 JSON: {str(e)}"
                    }
                    return

                thought = output.get('thought', '')
                actions = output.get('actions', [])
                final_answer = output.get('final_answer')

                self.logger.info(f"[MasterV2] Thought: {thought[:100]}...")

                # 🎯 如果有 Agent 调用，需要先发送 subtask_start，再发送 thought
                # 但如果没有 Agent 调用，则不需要 subtask_start
                # 为了简化，我们在执行 Agent 调用的循环中发送 thought_structured

                # 添加 assistant 消息
                messages.append({
                    "role": "assistant",
                    "content": response.content
                })

                # 检查是否有最终答案
                if final_answer:
                    self.logger.info(f"[MasterV2] 得到最终答案")
                    yield {
                        "type": "final_answer",
                        "content": final_answer,
                        "metadata": {
                            'rounds': rounds,
                            'agent_calls': len(agent_calls_history),
                            'execution_time': time.time() - start_time
                        }
                    }
                    return

                # 执行 Agent 调用
                if actions and len(actions) > 0:
                    self.logger.info(f"[MasterV2] 执行 {len(actions)} 个 Agent 调用")

                    observations = []
                    agent_results = {}

                    for idx, action in enumerate(actions, 1):
                        tool_name = action.get('tool')
                        arguments = action.get('arguments', {})

                        if not tool_name:
                            continue

                        # 解析出 Agent 名称
                        agent_name = parse_agent_invocation(tool_name)
                        if not agent_name:
                            error_msg = f"无效的 Agent 工具名称: {tool_name}"
                            self.logger.warning(f"[MasterV2] {error_msg}")
                            observations.append(f"**Agent 调用 {idx}**: 失败\n错误: {error_msg}")
                            continue

                        # 提取参数
                        agent_task = arguments.get('task', '')
                        context_hint = arguments.get('context_hint')

                        self.logger.info(f"[MasterV2] [{idx}/{len(actions)}] 调用 Agent: {agent_name}")
                        self.logger.info(f"[MasterV2] 任务: {agent_task[:100]}...")

                        # 🎯 使用前端已支持的 subtask_start 事件（而非 agent_call_start）
                        # 这样前端可以无缝展示 Agent 调用，就像 Master V1 的子任务一样
                        task_id = f"v2_agent_{rounds}_{idx}"  # 生成唯一的 task_id
                        agent_display_name = self._get_agent_display_name(agent_name)

                        yield {
                            "type": "subtask_start",
                            "task_id": task_id,  # V2 新增 task_id 用于精确追踪
                            "order": idx,
                            "agent_name": agent_name,
                            "agent_display_name": agent_display_name,
                            "description": agent_task
                        }

                        # 🎯 在 Agent 调用后，立即发送 thought（关联到这个 subtask）
                        yield {
                            "type": "thought_structured",
                            "task_id": task_id,  # 关联到当前 Agent 调用
                            "subtask_order": idx,
                            "thought": thought,
                            "round": rounds,
                            "has_actions": True,
                            "has_answer": False
                        }

                        # 执行 Agent
                        agent_start = time.time()
                        result = self.agent_executor.execute_agent(
                            agent_name=agent_name,
                            task=agent_task,
                            context=context,
                            context_hint=context_hint
                        )
                        elapsed_time = time.time() - agent_start

                        # 🎯 使用前端已支持的 subtask_end 事件（而非 agent_call_end）
                        result_summary = self._format_agent_result_summary(result)
                        yield {
                            "type": "subtask_end",
                            "task_id": task_id,
                            "order": idx,
                            "result_summary": result_summary,
                            "success": result.get('success', False)
                        }

                        # 记录调用历史
                        agent_calls_history.append({
                            'agent_name': agent_name,
                            'task': agent_task,
                            'result': result
                        })

                        # 存储结果供后续引用
                        agent_results[idx] = result

                        # 格式化观察结果
                        observation = self.observation_formatter.format(
                            result,
                            tool_name=agent_name,
                            is_skills_tool=False
                        )
                        observations.append(f"**Agent {idx} ({agent_name})**:\n{observation}")

                    # 将所有结果作为 user 消息添加
                    combined_observations = "\n\n".join(observations)
                    messages.append({
                        "role": "user",
                        "content": f"Agent 执行结果：\n\n{combined_observations}\n\n请基于以上结果继续分析并决定下一步行动。"
                    })

                    continue
                else:
                    # 没有 Agent 调用但也没有最终答案
                    self.logger.warning(f"[MasterV2] 既没有调用 Agent 也没有给出最终答案")
                    messages.append({
                        "role": "user",
                        "content": "请根据当前信息给出最终答案，或者说明需要调用哪个 Agent 获取更多信息。"
                    })
                    continue

            # 达到最大轮数
            self.logger.warning(f"[MasterV2] 达到最大轮数 {self.max_rounds}")
            yield {
                "type": "final_answer",
                "content": "抱歉，经过多轮分析后仍无法给出完整答案。建议重新描述问题或提供更多信息。",
                "metadata": {
                    'rounds': rounds,
                    'max_rounds_reached': True,
                    'agent_calls': len(agent_calls_history),
                    'execution_time': time.time() - start_time
                }
            }

        except Exception as e:
            self.logger.error(f"执行任务失败: {e}", exc_info=True)
            yield {
                "type": "error",
                "content": str(e)
            }

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """执行任务（非流式版本，兼容旧接口）"""
        # 收集流式输出
        final_content = ""
        metadata = {}

        for event in self.execute_stream(task, context):
            if event['type'] == 'final_answer':
                final_content = event['content']
                metadata = event.get('metadata', {})
                break
            elif event['type'] == 'error':
                return AgentResponse(
                    success=False,
                    error=event['content'],
                    agent_name=self.name
                )

        return AgentResponse(
            success=True,
            content=final_content,
            agent_name=self.name,
            metadata=metadata
        )

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        Master V2 作为统一入口，处理所有任务
        """
        return True
