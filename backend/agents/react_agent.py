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
import os
import time
from typing import Optional, Dict, Any, List
import uuid
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
        available_skills: Optional[List] = None,  # 新增：Skills 列表
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
        self.available_skills = available_skills or []  # 新增：保存 Skills
        self.event_callback = event_callback  # 保存回调函数

        # 从配置获取行为参数
        behavior_config = agent_config.custom_params.get('behavior', {}) if agent_config else {}
        self.max_rounds = behavior_config.get('max_rounds', 10)
        self.base_prompt = behavior_config.get('system_prompt', '')

        logger.info(f"ReActAgent '{self.name}' 初始化完成，可用工具: {len(self.available_tools)}，可用 Skills: {len(self.available_skills)}")

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

        # 构建 Skills 说明
        skills_desc = self._format_skills_description()

        # 🔒 动态生成示例：使用当前智能体可用的工具
        # 避免硬编码工具名称，防止 LLM 学习到未授权的工具
        example_tool_name = self.available_tools[0]['function']['name'] if self.available_tools else "tool_name"
        example_params = self.available_tools[0]['function'].get('parameters', {}).get('properties', {})

        # 构造示例参数（取第一个参数作为示例）
        if example_params:
            first_param = list(example_params.keys())[0]
            example_arg = {first_param: "示例值"}
        else:
            example_arg = {}

        parallel_example = f"""```json
{{
  "thought": "分析任务需求，如果需要执行多个独立操作，可以并行调用工具",
  "actions": [
    {{
      "tool": "{example_tool_name}",
      "arguments": {example_arg}
    }}
  ],
  "final_answer": null
}}
```"""

        return f"""{self.base_prompt}

## 可用工具

{tools_desc}

## 领域知识 (Skills)

{skills_desc}

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
1. **只能使用上面"可用工具"部分列出的工具**，不要使用其他工具
2. **可以一次执行多个独立的工具调用**（actions 是数组）
   - 如果多个工具调用之间没有依赖关系，可以在一轮中同时调用
   - 例如：同时查询多个地区的数据、同时检索不同类型的信息
3. **有依赖关系的工具调用需要分轮执行**
   - 如果工具B需要工具A的结果，则分两轮：先调用A，下一轮基于结果调用B
4. 在 thought 中解释你为什么选择这些工具
5. 当你有足够信息回答问题时，在 final_answer 中给出答案
6. 如果工具返回了错误，在下一轮 thought 中分析原因并调整策略

**关于数据处理的重要规则：**
1. **小数据**：直接在 `thought` 中分析。
2. **大数据**：如果工具返回结果提示“数据已保存至文件”，说明数据量过大。
   - **不要** 尝试让工具打印文件内容。
   - **直接** 将该文件路径作为参数传递给下一个工具。
3. **数据格式转换（关键）**：
   - 如果上一个工具输出的文件格式（例如 JSON 列表）不符合下一个工具的要求（例如需要 CSV 格式，或需要提取特定字段），你 **不能** 直接传递文件路径。
   - 你必须使用 `process_data_file` 工具，编写 Pandas 代码将数据转换为目标格式。
   - **步骤**：
     1. 观察上一个工具返回的元数据（字段名、数据类型）。
     2. 思考下一个工具需要什么格式（例如需要 'time' 和 'value' 两个字段）。
     3. 调用 `process_data_file`，在 `python_code` 中编写 DataFrame 转换逻辑。
     4. 将 `process_data_file` 返回的新文件路径传递给下一个工具。

**并行调用示例**：
{parallel_example}

只返回 JSON，不要有其他内容。
"""

    def _format_skills_description(self) -> str:
        """
        格式化 Skills 说明（仅列出 name 和 description）

        根据 Claude Skills 的渐进式披露原则：
        1. System Prompt 只包含 name + description（最小化信息）
        2. AI 判断需要时，调用 activate_skill 工具激活 Skill 并加载主文件
        3. AI 根据主文件提示，调用 load_skill_resource 加载引用文件
        4. AI 根据主文件指示，调用 execute_skill_script 执行脚本

        Skills 不是工具，而是领域知识指南，告诉 Agent 如何更好地完成特定任务。
        """
        if not self.available_skills:
            return "当前无可用的领域知识。"

        lines = []
        lines.append("## 领域知识 Skills")
        lines.append("")
        lines.append("以下是可用的领域知识 Skills。使用流程：")
        lines.append("")
        lines.append("**第 1 步**：当任务匹配某个 Skill 的场景时，调用 `activate_skill(skill_name)` 激活它")
        lines.append("  - 效果：加载 SKILL.md 主文件，获取完整指导流程")
        lines.append("  - 返回：主文件内容 + 可用的资源和脚本列表")
        lines.append("")
        lines.append("**第 2 步**：根据主文件中的提示，使用 `load_skill_resource` 加载详细文档")
        lines.append("")
        lines.append("**第 3 步**：根据主文件中的指示，使用 `execute_skill_script` 执行脚本")
        lines.append("")
        lines.append("---")
        lines.append("")

        for idx, skill in enumerate(self.available_skills, 1):
            lines.append(f"### Skill {idx}: {skill.name}")
            lines.append(f"**适用场景**: {skill.description}")
            lines.append("")

        return "\n".join(lines)

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

                # 重试机制：最多尝试 3 次解析
                max_parse_retries = 3
                output = None

                for retry_attempt in range(max_parse_retries):
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
                        # 解析成功，跳出重试循环
                        if retry_attempt > 0:
                            self.logger.info(f"第 {retry_attempt + 1} 次尝试成功解析 JSON")
                        break
                    except json.JSONDecodeError as e:
                        # 尝试使用 strict=False 解析
                        try:
                            output = json.loads(response.content, strict=False)
                            self.logger.info(f"使用 strict=False 成功解析 JSON (尝试 {retry_attempt + 1}/{max_parse_retries})")
                            break
                        except json.JSONDecodeError as e2:
                            self.logger.warning(
                                f"第 {retry_attempt + 1}/{max_parse_retries} 次 JSON 解析失败: {str(e2)}"
                            )

                            if retry_attempt < max_parse_retries - 1:
                                # 还有重试机会，向 LLM 反馈错误并要求重新生成
                                self.logger.info("要求 LLM 重新生成有效的 JSON...")
                                messages.append({
                                    "role": "assistant",
                                    "content": response.content[:200] + "..."  # 只添加部分内容
                                })
                                messages.append({
                                    "role": "user",
                                    "content": f"你的上一个响应包含 JSON 格式错误: {str(e2)}。请重新生成一个**严格符合 JSON 规范**的响应，确保所有字符串内的换行符、制表符等特殊字符都被正确转义（如 \\n, \\t）。"
                                })
                            else:
                                # 已达到最大重试次数
                                self.logger.error(f"达到最大重试次数，无法解析 LLM 响应: {response.content[:500]}... (已截断)")
                                yield {
                                    "type": "error",
                                    "content": f"LLM 多次返回无效的 JSON（已重试 {max_parse_retries} 次）: {str(e2)}"
                                }
                                return

                # 如果所有重试都失败
                if output is None:
                    yield {
                        "type": "error",
                        "content": "无法从 LLM 获取有效的 JSON 响应"
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

                        # 🔒 安全检查：验证工具权限
                        allowed_tool_names = [
                            tool['function']['name']
                            for tool in self.available_tools
                        ]
                        if tool_name not in allowed_tool_names:
                            error_msg = f"权限拒绝：智能体 '{self.name}' 不允许使用工具 '{tool_name}'。允许的工具: {allowed_tool_names}"
                            self.logger.warning(f"[ReAct] {error_msg}")

                            # 返回权限错误
                            result = {
                                "success": False,
                                "error": error_msg
                            }

                            # yield 工具错误事件
                            yield {
                                "type": "tool_error",
                                "tool_name": tool_name,
                                "error": error_msg,
                                "index": idx,
                                "total": len(actions)
                            }

                            # 添加到观察结果
                            observations.append(f"**工具 {idx}: {tool_name}**\n错误: {error_msg}")
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

                        # 关键：检查工具是否返回了图表配置或地图配置，如果是，额外发送相应事件
                        # 让前端能直接捕获并渲染，不需要等最终答案
                        # 适配新的标准化响应格式
                        if isinstance(result, dict) and result.get('success'):
                            data = result.get('data', {})
                            results = data.get('results', {})

                            # 检查是否有图表配置
                            if isinstance(results, dict) and 'echarts_config' in results:
                                echarts_config = results['echarts_config']
                                chart_type = results.get('chart_type', 'bar')
                                title = echarts_config.get('title', {}).get('text', '图表分析')

                                yield {
                                    "type": "chart_generated",
                                    "echarts_config": echarts_config,
                                    "chart_type": chart_type,
                                    "title": title
                                }

                            # 检查是否有地图配置
                            elif isinstance(results, dict) and 'map_type' in results:
                                map_type = results.get('map_type')
                                title = results.get('title', '地图可视化')

                                yield {
                                    "type": "map_generated",
                                    "mapData": results,  # 包含 map_type, heat_data, markers, bounds等
                                    "title": title
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

                # 重试机制：最多尝试 3 次解析
                max_parse_retries = 3
                output = None

                for retry_attempt in range(max_parse_retries):
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
                        # 解析成功，跳出重试循环
                        if retry_attempt > 0:
                            self.logger.info(f"第 {retry_attempt + 1} 次尝试成功解析 JSON")
                        break
                    except json.JSONDecodeError as e:
                        # 尝试使用 strict=False 解析
                        try:
                            output = json.loads(response.content, strict=False)
                            self.logger.info(f"使用 strict=False 成功解析 JSON (尝试 {retry_attempt + 1}/{max_parse_retries})")
                            break
                        except json.JSONDecodeError as e2:
                            self.logger.warning(
                                f"第 {retry_attempt + 1}/{max_parse_retries} 次 JSON 解析失败: {str(e2)}"
                            )

                            if retry_attempt < max_parse_retries - 1:
                                # 还有重试机会，向 LLM 反馈错误并要求重新生成
                                self.logger.info("要求 LLM 重新生成有效的 JSON...")
                                messages.append({
                                    "role": "assistant",
                                    "content": response.content[:200] + "..."  # 只添加部分内容
                                })
                                messages.append({
                                    "role": "user",
                                    "content": f"你的上一个响应包含 JSON 格式错误: {str(e2)}。请重新生成一个**严格符合 JSON 规范**的响应，确保所有字符串内的换行符、制表符等特殊字符都被正确转义（如 \\n, \\t）。"
                                })
                            else:
                                # 已达到最大重试次数
                                self.logger.error(f"达到最大重试次数，无法解析 LLM 响应: {response.content[:500]}... (已截断)")
                                return AgentResponse(
                                    success=False,
                                    content="",
                                    error=f"LLM 多次返回无效的 JSON（已重试 {max_parse_retries} 次）: {str(e2)}",
                                    agent_name=self.name,
                                    execution_time=time.time() - start_time
                                )

                # 如果所有重试都失败
                if output is None:
                    return AgentResponse(
                        success=False,
                        content="",
                        error="无法从 LLM 获取有效的 JSON 响应",
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

    # def _format_observation(self, result: Any) -> str:
    #     """格式化工具执行结果为观察文本"""
    #     if isinstance(result, dict):
    #         if result.get('success'):
    #             data = result.get('data', {})
    #             if 'answer' in data:
    #                 return data['answer']
    #             return json.dumps(data, ensure_ascii=False, indent=2)
    #         else:
    #             return f"错误: {result.get('error', '未知错误')}"
    #     return str(result)
    def _format_observation(self, result: Any) -> str:
        """
        格式化观察结果：实现数据流与控制流的分离策略

        新版本支持标准化工具响应格式：
        {
            "success": bool,
            "data": {
                "results": ...,      # 纯净数据
                "metadata": {...},   # 元数据（优先使用）
                "summary": "...",    # 摘要
                "answer": "..."      # 答案（可选）
            }
        }
        """
        # 1. 处理错误响应
        if isinstance(result, dict):
            if not result.get('success'):
                return f"错误: {result.get('error', '未知错误')}"

            # 2. 提取 data 字段
            data = result.get('data', {})

            # 3. 提取核心字段
            pure_data = data.get('results')
            summary = data.get('summary', '')
            metadata = data.get('metadata', {})  # 工具返回的元数据
            answer = data.get('answer')  # 查询类工具的完整答案

            # 4. 如果没有标准化格式，尝试兼容旧格式
            if pure_data is None:
                # 兼容旧格式：直接返回 data
                pure_data = data

            # 5. 转换为字符串以判断大小
            content_str = json.dumps(pure_data, ensure_ascii=False) if isinstance(pure_data, (dict, list)) else str(pure_data)

            # 6. 【核心逻辑】阈值判断 (2000 字符)
            if len(content_str) < 2000:
                # 小数据：直接透传
                # 如果有 answer，也一并返回
                if answer:
                    return f"{answer}\n\n[数据详情]\n{json.dumps(data, ensure_ascii=False, indent=2)}"
                return json.dumps(data, ensure_ascii=False, indent=2)

            # 7. 【大数据处理】执行分离策略
            else:
                # A. 生成存储路径
                file_name = f"data_{uuid.uuid4().hex}.json"
                save_dir = "./static/temp_data"
                os.makedirs(save_dir, exist_ok=True)
                file_path = os.path.join(save_dir, file_name)

                # B. 构建元数据提示（优先使用工具返回的 metadata）
                meta_info = summary if summary else "数据量过大，已自动转存。"

                # 优先使用工具返回的 metadata
                if metadata and metadata.get('fields'):
                    total_count = metadata.get('total_count', 0)
                    fields = metadata.get('fields', [])
                    sample = metadata.get('sample')

                    meta_info += f" 类型: {metadata.get('data_type', 'List')}, 总数: {total_count} 条。"

                    # 显示字段信息
                    if fields:
                        field_info = [f"{f['name']}({f['type']})" for f in fields[:10]]
                        meta_info += f" 包含字段: {', '.join(field_info)}"
                        if len(fields) > 10:
                            meta_info += f" 等 {len(fields)} 个字段"

                    # 显示样本数据
                    if sample:
                        meta_info += f"\n  样本数据 (第1条): {json.dumps(sample, ensure_ascii=False)[:300]}..."

                else:
                    # 如果工具未返回 metadata，回退到原有逻辑（从 pure_data 提取）
                    if isinstance(pure_data, list):
                        meta_info += f" 类型: List, 长度: {len(pure_data)} 条。"
                        if len(pure_data) > 0:
                            first_item = pure_data[0]
                            if isinstance(first_item, dict):
                                keys_info = [f"{k}({type(v).__name__})" for k, v in first_item.items()]
                                meta_info += f" 包含字段: {', '.join(keys_info)}"
                                meta_info += f"\n  样本数据 (第1条): {json.dumps(first_item, ensure_ascii=False)[:200]}..."
                    elif isinstance(pure_data, dict):
                        meta_info += f" 类型: Dict, 顶层键: {list(pure_data.keys())}"

                # C. 保存纯净数据到文件
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(pure_data, f, ensure_ascii=False, indent=2)

                # D. 构建返回信息
                observation_parts = []

                # 如果有 answer（查询类工具），先返回 answer
                if answer:
                    observation_parts.append(f"[查询结果]\n{answer}")
                    observation_parts.append("")  # 空行分隔

                # 然后返回数据引用信息
                observation_parts.append(f"[系统提示] {meta_info}")
                observation_parts.append(f'数据已保存至文件: "{file_path}"')
                observation_parts.append("请使用此文件路径作为后续工具（如绘图、分析）的输入参数，不要尝试直接读取内容。")
                observation_parts.append("如果下一个工具需要的格式与上述字段不匹配，请先调用 `process_data_file` 工具进行转换。")

                return "\n".join(observation_parts)

        # 8. 兼容非字典响应
        return str(result)

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        ReAct Agent 始终返回 True，让 MasterAgent 通过 LLM 智能分析来决定路由
        """
        return True
