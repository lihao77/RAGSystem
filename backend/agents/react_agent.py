# -*- coding: utf-8 -*-
"""
ReAct Agent - 使用 Structured Output 替代 Function Calling

优势：
1. 不依赖 function calling API
2. 支持任何支持 JSON mode 的模型
3. 推理过程可见
4. 更容易调试和维护
"""

import logging
import json
import time
from typing import Optional, Dict, Any, List
from .base import BaseAgent, AgentContext, AgentResponse
from tools.tool_executor import execute_tool

logger = logging.getLogger(__name__)


class ReActAgent(BaseAgent):
    """
    ReAct (Reasoning + Acting) 智能体

    使用结构化输出代替 function calling，更加灵活和可控
    """

    # 输出格式定义
    RESPONSE_SCHEMA = {
        "type": "object",
        "properties": {
            "thought": {
                "type": "string",
                "description": "当前的思考过程"
            },
            "actions": {
                "type": "array",
                "description": "要执行的工具调用列表（可以一次调用多个独立的工具）",
                "items": {
                    "type": "object",
                    "properties": {
                        "tool": {"type": "string", "description": "工具名称"},
                        "arguments": {"type": "object", "description": "工具参数"}
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
        agent_name: str,
        display_name: str = None,
        description: str = None,
        llm_adapter = None,
        agent_config = None,
        system_config = None,
        available_tools: Optional[List[Dict[str, Any]]] = None,
        event_callback = None  # 新增：事件回调函数
    ):
        super().__init__(
            name=agent_name,
            description=description or display_name or agent_name,
            capabilities=['reasoning', 'tool_calling'],
            llm_adapter=llm_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.display_name = display_name or agent_name
        self.available_tools = available_tools or []
        self.event_callback = event_callback  # 保存回调函数

        # 从配置获取行为参数
        behavior_config = agent_config.custom_params.get('behavior', {}) if agent_config else {}
        self.max_rounds = behavior_config.get('max_rounds', 10)
        self.base_prompt = behavior_config.get('system_prompt', '')

        logger.info(f"ReActAgent '{self.name}' 初始化完成，可用工具: {len(self.available_tools)}")

    def _emit_event(self, event_type: str, data: Dict[str, Any]):
        """发送事件到回调函数"""
        if self.event_callback:
            try:
                self.event_callback(event_type, data)
            except Exception as e:
                self.logger.warning(f"事件回调失败: {e}")

    def _build_system_prompt(self) -> str:
        """构建系统提示词"""
        # 构建详细的工具说明（包含参数定义）
        tools_desc_lines = []
        for tool in self.available_tools:
            func = tool['function']
            name = func['name']
            desc = func['description']
            params = func.get('parameters', {})

            # 基本描述
            tools_desc_lines.append(f"\n### {name}")
            tools_desc_lines.append(f"**描述**: {desc}")

            # 参数说明
            if params and 'properties' in params:
                tools_desc_lines.append("**参数**:")
                required = params.get('required', [])
                for param_name, param_info in params['properties'].items():
                    param_type = param_info.get('type', 'any')
                    param_desc = param_info.get('description', '')
                    required_mark = " (必填)" if param_name in required else " (可选)"
                    tools_desc_lines.append(f"  - `{param_name}` ({param_type}){required_mark}: {param_desc}")

            # 示例（如果有）
            if 'examples' in func:
                tools_desc_lines.append("**示例**:")
                for example in func['examples']:
                    tools_desc_lines.append(f"  ```json\n  {example}\n  ```")
                    
        tools_desc = "\n".join(tools_desc_lines)

        return f"""{self.base_prompt}

## 可用工具

{tools_desc}

## 工作方式

你需要以 JSON 格式返回你的思考和行动：

```json
{{
  "thought": "我的思考过程...",
  "actions": [
    {{
      "tool": "工具名称1",
      "arguments": {{"参数名": "参数值"}}
    }},
    {{
      "tool": "工具名称2",
      "arguments": {{"参数名": "参数值"}}
    }}
  ],
  "final_answer": null  // 如果还没有最终答案
}}
```

**重要规则：**
1. **可以一次执行多个独立的工具调用**（actions 是数组）
   - 如果多个工具调用之间没有依赖关系，可以在一轮中同时调用
   - 例如：同时查询多个地区的数据、同时检索不同类型的信息
2. **有依赖关系的工具调用需要分轮执行**
   - 如果工具B需要工具A的结果，则分两轮：先调用A，下一轮基于结果调用B
3. 在 thought 中解释你为什么选择这些工具
4. 当你有足够信息回答问题时，在 final_answer 中给出答案
5. 如果工具返回了错误，在下一轮 thought 中分析原因并调整策略

**并行调用示例**：
```json
{{
  "thought": "需要查询南宁和桂林两个城市的洪涝灾害数据，这两个查询是独立的，可以并行执行",
  "actions": [
    {{
      "tool": "query_knowledge_graph_with_nl",
      "arguments": {{"question": "南宁市的洪涝灾害历史"}}
    }},
    {{
      "tool": "query_knowledge_graph_with_nl",
      "arguments": {{"question": "桂林市的洪涝灾害历史"}}
    }}
  ],
  "final_answer": null
}}
```

只返回 JSON，不要有其他内容。
"""

    def execute_stream(self, task: str, context: AgentContext):
        """
        流式执行任务（生成器版本）

        在每个关键事件点 yield 事件字典：
        - thought_structured: 思考过程
        - tool_start: 工具开始执行
        - tool_end: 工具执行完成
        - final_answer: 最终答案
        - error: 错误信息
        """
        start_time = time.time()

        try:
            # 初始化对话历史
            messages = [
                {"role": "system", "content": self._build_system_prompt()},
                {"role": "user", "content": task}
            ]

            rounds = 0
            tool_calls_history = []

            while rounds < self.max_rounds:
                rounds += 1
                self.logger.info(f"[ReAct] 第 {rounds} 轮推理")

                # 获取 LLM 配置
                llm_config = self.get_llm_config()

                # 调用 LLM（使用 JSON mode）
                response = self.llm_adapter.chat_completion(
                    messages=messages,
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
                    self.logger.error(f"无法解析 LLM 响应: {response.content}")
                    yield {
                        "type": "error",
                        "content": f"LLM 返回了无效的 JSON: {str(e)}"
                    }
                    return

                thought = output.get('thought', '')
                actions = output.get('actions', [])
                final_answer = output.get('final_answer')

                self.logger.info(f"[ReAct] Thought: {thought[:100]}...")

                # 实时 yield 思考过程
                yield {
                    "type": "thought_structured",
                    "thought": thought,
                    "round": rounds,
                    "has_actions": len(actions) > 0,
                    "has_answer": final_answer is not None
                }

                # 添加 assistant 消息
                messages.append({
                    "role": "assistant",
                    "content": response.content
                })

                # 检查是否有最终答案
                if final_answer:
                    self.logger.info(f"[ReAct] 得到最终答案")
                    yield {
                        "type": "final_answer",
                        "content": final_answer,
                        "metadata": {
                            'rounds': rounds,
                            'execution_time': time.time() - start_time
                        }
                    }
                    return

                # 检查是否需要执行工具（支持多个工具并行）
                if actions and len(actions) > 0:
                    self.logger.info(f"[ReAct] 执行 {len(actions)} 个工具调用")

                    # 收集所有工具的执行结果
                    observations = []

                    for idx, action in enumerate(actions, 1):
                        tool_name = action.get('tool')
                        arguments = action.get('arguments', {})

                        if not tool_name:
                            continue

                        self.logger.info(f"[ReAct] [{idx}/{len(actions)}] 执行工具: {tool_name}, 参数: {arguments}")

                        # 实时 yield 工具开始事件
                        yield {
                            "type": "tool_start",
                            "tool_name": tool_name,
                            "arguments": arguments,
                            "index": idx,
                            "total": len(actions)
                        }

                        # 执行工具
                        tool_start = time.time()
                        result = execute_tool(tool_name, arguments)
                        elapsed_time = time.time() - tool_start

                        # 实时 yield 工具结束事件
                        yield {
                            "type": "tool_end",
                            "tool_name": tool_name,
                            "result": result,
                            "elapsed_time": elapsed_time,
                            "index": idx,
                            "total": len(actions)
                        }

                        # 记录工具调用
                        tool_calls_history.append({
                            'tool_name': tool_name,
                            'arguments': arguments,
                            'result': result
                        })

                        # 格式化观察结果
                        observation = self._format_observation(result)
                        observations.append(f"**工具 {idx}: {tool_name}**\n{observation}")

                    # 将所有结果作为 user 消息添加
                    combined_observations = "\n\n".join(observations)
                    messages.append({
                        "role": "user",
                        "content": f"工具执行结果：\n\n{combined_observations}\n\n请基于以上结果继续分析并决定下一步行动。"
                    })

                    continue
                else:
                    # 没有工具调用但也没有最终答案
                    self.logger.warning(f"[ReAct] LLM 既没有调用工具也没有给出最终答案")
                    messages.append({
                        "role": "user",
                        "content": "请根据当前信息给出最终答案，或者说明需要使用哪个工具获取更多信息。"
                    })
                    continue

            # 达到最大轮数
            self.logger.warning(f"[ReAct] 达到最大轮数 {self.max_rounds}")
            yield {
                "type": "final_answer",
                "content": "抱歉，经过多轮分析后仍无法给出完整答案。建议重新描述问题或提供更多信息。",
                "metadata": {
                    'rounds': rounds,
                    'max_rounds_reached': True,
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
        start_time = time.time()

        try:
            # 初始化对话历史
            messages = [
                {"role": "system", "content": self._build_system_prompt()},
                {"role": "user", "content": task}
            ]

            rounds = 0
            tool_calls_history = []

            while rounds < self.max_rounds:
                rounds += 1
                self.logger.info(f"[ReAct] 第 {rounds} 轮推理")

                # 获取 LLM 配置
                llm_config = self.get_llm_config()

                # 调用 LLM（使用 JSON mode）
                response = self.llm_adapter.chat_completion(
                    messages=messages,
                    provider=llm_config.get('provider'),
                    model=llm_config.get('model_name'),
                    temperature=llm_config.get('temperature', 0.3),
                    max_tokens=llm_config.get('max_tokens'),
                    # 关键：使用 JSON mode 而不是 function calling
                    response_format={"type": "json_object"}
                )

                if response.error:
                    return AgentResponse(
                        success=False,
                        content="",
                        error=f"LLM 调用失败: {response.error}",
                        agent_name=self.name,
                        execution_time=time.time() - start_time
                    )

                # 解析 JSON 响应
                try:
                    output = json.loads(response.content)
                except json.JSONDecodeError as e:
                    self.logger.error(f"无法解析 LLM 响应: {response.content}")
                    return AgentResponse(
                        success=False,
                        content="",
                        error=f"LLM 返回了无效的 JSON: {str(e)}",
                        agent_name=self.name,
                        execution_time=time.time() - start_time
                    )

                thought = output.get('thought', '')
                actions = output.get('actions', [])
                final_answer = output.get('final_answer')

                self.logger.info(f"[ReAct] Thought: {thought[:100]}...")

                # 发送结构化的思考过程事件
                self._emit_event('thought_structured', {
                    'thought': thought,
                    'round': rounds + 1,
                    'has_actions': len(actions) > 0,
                    'has_answer': final_answer is not None
                })

                # 添加 assistant 消息
                messages.append({
                    "role": "assistant",
                    "content": response.content
                })

                # 检查是否有最终答案
                if final_answer:
                    self.logger.info(f"[ReAct] 得到最终答案")
                    return AgentResponse(
                        success=True,
                        content=final_answer,
                        agent_name=self.name,
                        execution_time=time.time() - start_time,
                        tool_calls=tool_calls_history,
                        metadata={
                            'rounds': rounds,
                            'reasoning_steps': [msg for msg in messages if msg['role'] == 'assistant']
                        }
                    )

                # 检查是否需要执行工具（支持多个工具并行）
                if actions and len(actions) > 0:
                    self.logger.info(f"[ReAct] 执行 {len(actions)} 个工具调用")

                    # 收集所有工具的执行结果
                    observations = []

                    for idx, action in enumerate(actions, 1):
                        tool_name = action.get('tool')
                        arguments = action.get('arguments', {})

                        if not tool_name:
                            continue

                        self.logger.info(f"[ReAct] [{idx}/{len(actions)}] 执行工具: {tool_name}, 参数: {arguments}")

                        # 发送工具开始事件
                        self._emit_event('tool_start', {
                            'tool_name': tool_name,
                            'arguments': arguments,
                            'index': idx,
                            'total': len(actions)
                        })

                        # 执行工具
                        start_time = time.time()
                        result = execute_tool(tool_name, arguments)
                        elapsed_time = time.time() - start_time

                        # 发送工具结束事件
                        self._emit_event('tool_end', {
                            'tool_name': tool_name,
                            'result': result,
                            'elapsed_time': elapsed_time,
                            'index': idx,
                            'total': len(actions)
                        })

                        # 记录工具调用
                        tool_calls_history.append({
                            'tool_name': tool_name,
                            'arguments': arguments,
                            'result': result
                        })

                        # 格式化观察结果
                        observation = self._format_observation(result)
                        observations.append(f"**工具 {idx}: {tool_name}**\n{observation}")

                    # 将所有结果作为 user 消息添加
                    combined_observations = "\n\n".join(observations)
                    messages.append({
                        "role": "user",
                        "content": f"工具执行结果：\n\n{combined_observations}\n\n请基于以上结果继续分析并决定下一步行动。"
                    })

                    continue
                else:
                    # 没有工具调用但也没有最终答案，可能是 LLM 困惑了
                    self.logger.warning(f"[ReAct] LLM 既没有调用工具也没有给出最终答案")
                    messages.append({
                        "role": "user",
                        "content": "请根据当前信息给出最终答案，或者说明需要使用哪个工具获取更多信息。"
                    })
                    continue

            # 达到最大轮数
            self.logger.warning(f"[ReAct] 达到最大轮数 {self.max_rounds}")
            return AgentResponse(
                success=True,
                content="抱歉，经过多轮分析后仍无法给出完整答案。建议重新描述问题或提供更多信息。",
                agent_name=self.name,
                execution_time=time.time() - start_time,
                tool_calls=tool_calls_history,
                metadata={'rounds': rounds, 'max_rounds_reached': True}
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

    def _format_observation(self, result: Any) -> str:
        """格式化工具执行结果为观察文本"""
        if isinstance(result, dict):
            if result.get('success'):
                data = result.get('data', {})
                if 'answer' in data:
                    return data['answer']
                return json.dumps(data, ensure_ascii=False, indent=2)
            else:
                return f"错误: {result.get('error', '未知错误')}"
        return str(result)

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        ReAct Agent 始终返回 True，让 MasterAgent 通过 LLM 智能分析来决定路由
        """
        return True
