# -*- coding: utf-8 -*-
"""
MasterAgent - 主协调智能体

职责：
1. 分析任务复杂度
2. 自动任务分解
3. 智能体编排和协调
4. 结果整合和总结
"""

import logging
import json
import time
from typing import Dict, List, Any, Optional, Generator
from .base import BaseAgent, AgentContext, AgentResponse

logger = logging.getLogger(__name__)


class MasterAgent(BaseAgent):
    """
    主协调智能体

    能够：
    - 识别任务是否需要分解
    - 自动将复杂任务分解为子任务
    - 协调多个专业智能体协作
    - 整合各智能体的结果
    - 生成统一的答案

    适用场景：
    - "生成一份完整的灾害分析报告"
    - "分析数据、绘制图表并给出建议"
    - "查询数据、对比分析并可视化"
    """

    # 任务分析提示词
    TASK_ANALYSIS_PROMPT = """你是一个任务规划专家。分析用户的任务，判断是否需要多个智能体协作。

可用智能体：
{agents_info}

请分析以下任务：
"{task}"

你需要判断：
1. 任务复杂度（simple/medium/complex）
2. 是否需要多个智能体（true/false）
3. **必须在 subtasks 中明确指定要使用的智能体**（即使只有一个）

请以 JSON 格式返回：
{{
  "complexity": "simple|medium|complex",
  "needs_multiple_agents": true|false,
  "reasoning": "你的分析理由",
  "subtasks": [
    {{
      "description": "子任务描述",
      "agent": "智能体名称",
      "order": 1,
      "depends_on": []  // 依赖的子任务序号
    }}
  ]
}}

**重要：subtasks 数组不能为空！**
- 如果是 simple 任务，subtasks 中应该有 **1个** 元素，指定使用哪个智能体
- 如果是 complex 任务，subtasks 中应该有 **多个** 元素，按执行顺序排列
- 如果任务是闲聊或不需要特定智能体的通用对话，agent 设为 "master_agent"

**判断标准：**
- simple: 单一查询、单一操作，一个智能体即可完成
- medium: 需要多步骤，但可以由一个智能体通过工具调用完成
- complex: 需要不同类型的操作（查询+分析+可视化+报告），必须多个智能体协作

**示例1：**
输入: "查询南宁2023年洪涝灾害数据"
输出:
{{
  "complexity": "simple",
  "needs_multiple_agents": false,
  "reasoning": "这是一个明确的知识图谱查询任务，qa_agent 可以独立完成",
  "subtasks": [
    {{
      "description": "查询南宁2023年洪涝灾害数据",
      "agent": "qa_agent",
      "order": 1,
      "depends_on": []
    }}
  ]
}}

**示例2：**
输入: "你好"
输出:
{{
  "complexity": "simple",
  "needs_multiple_agents": false,
  "reasoning": "这是通用闲聊，不需要特定智能体",
  "subtasks": [
    {{
      "description": "回复用户问候",
      "agent": "master_agent",
      "order": 1,
      "depends_on": []
    }}
  ]
}}

只返回 JSON，不要有其他内容。
"""

    # 结果整合提示词
    RESULT_SYNTHESIS_PROMPT = """你是一个结果整合专家。将多个智能体的执行结果整合为一个连贯的回答。

原始任务：
"{task}"

各智能体执行结果：
{results}

请整合以上结果，生成一个完整、连贯的回答。要求：
1. 保持逻辑清晰
2. 突出重点信息
3. 如果有图表，说明图表展示的内容
4. 给出总结性的结论

请直接返回整合后的回答，不要有额外的说明。
"""

    def __init__(
        self,
        llm_adapter,
        orchestrator,
        agent_config=None,
        system_config=None
    ):
        """
        初始化 MasterAgent

        Args:
            llm_adapter: LLM 适配器
            orchestrator: 智能体编排器（用于调用其他智能体）
            agent_config: 智能体独立配置（AgentConfig 实例）
            system_config: 系统配置对象（降级使用）
        """
        super().__init__(
            name='master_agent',
            description='主协调智能体，负责复杂任务的分解、编排和结果整合',
            capabilities=[
                'task_analysis',
                'task_decomposition',
                'agent_coordination',
                'result_synthesis'
            ],
            llm_adapter=llm_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.orchestrator = orchestrator

        self.logger.info("MasterAgent 初始化完成")

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        MasterAgent 作为统一入口，处理所有任务
        """
        return True  # 处理所有任务

    def _get_agent_display_name(self, agent_name: str) -> str:
        """
        获取智能体的友好显示名称

        优先从智能体的配置中获取 display_name，如果没有则使用默认映射

        Args:
            agent_name: 智能体技术名称（如 'react_agent'）

        Returns:
            str: 友好显示名称（如 'ReAct智能体'）
        """
        # 尝试从 orchestrator 获取智能体实例
        agent = self.orchestrator.agents.get(agent_name)

        # 如果智能体存在且有配置，从配置中获取 display_name
        if agent and hasattr(agent, 'agent_config') and agent.agent_config:
            display_name = agent.agent_config.display_name
            if display_name:
                return display_name

        # 降级：使用默认映射
        agent_display_names = {
            'react_agent': 'ReAct智能体',
            'qa_agent': '问答智能体',
            'search_agent': '搜索智能体',
            'master_agent': 'MasterAgent',
            'workflow_agent': '工作流智能体'
        }
        return agent_display_names.get(agent_name, agent_name)

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """
        执行任务
        """
        start_time = time.time()

        try:
            # 1. 分析任务
            self.logger.info(f"[MasterAgent] 开始分析任务: {task}")
            analysis = self._analyze_task(task, context)

            if not analysis:
                return AgentResponse(
                    success=False,
                    error="任务分析失败",
                    agent_name=self.name
                )

            # 2. 根据复杂度决定执行方式
            complexity = analysis.get('complexity', 'simple')
            needs_multiple = analysis.get('needs_multiple_agents', False)

            self.logger.info(
                f"[MasterAgent] 任务复杂度: {complexity}, "
                f"需要多智能体: {needs_multiple}"
            )

            # 如果是简单任务，委托给单个智能体
            if complexity == 'simple' or not needs_multiple:
                return self._delegate_to_single_agent(task, context, analysis)

            # 复杂任务，分解并协调执行
            return self._coordinate_multiple_agents(task, context, analysis)

        except Exception as e:
            self.logger.error(f"[MasterAgent] 执行失败: {e}", exc_info=True)
            return AgentResponse(
                success=False,
                error=f"执行失败: {str(e)}",
                agent_name=self.name,
                execution_time=time.time() - start_time
            )

    def stream_execute(self, task: str, context: AgentContext) -> Generator[Dict[str, Any], None, None]:
        """
        流式执行任务（支持 Server-Sent Events）

        Yields:
            {
                "type": "task_analysis" | "subtask_start" | "subtask_end" | "thought_structured" | "tool_start" | "tool_end" | "chunk" | "error",
                "content": "..." | other fields
            }
        """
        start_time = time.time()

        try:
            # 1. 分析任务
            self.logger.info(f"[MasterAgent] 开始分析任务: {task}")
            analysis = self._analyze_task(task, context)

            if not analysis:
                yield {
                    "type": "error",
                    "content": "任务分析失败"
                }
                return

            # 2. 根据复杂度决定执行方式
            complexity = analysis.get('complexity', 'simple')
            needs_multiple = analysis.get('needs_multiple_agents', False)
            subtasks = analysis.get('subtasks', [])
            subtask_count = len(subtasks) if needs_multiple else 1

            # Yield 任务分析结果（新格式）
            yield {
                "type": "task_analysis",
                "complexity": complexity,
                "subtask_count": subtask_count,
                "reasoning": analysis.get('reasoning', '')  # 不限制长度
            }

            # 如果是简单任务，委托给单个智能体
            if complexity == 'simple' or not needs_multiple:
                yield from self._stream_delegate_to_single_agent(task, context, analysis)
                return

            # 复杂任务，分解并协调执行
            yield from self._stream_coordinate_multiple_agents(task, context, analysis)

        except Exception as e:
            self.logger.error(f"[MasterAgent] 执行失败: {e}", exc_info=True)
            yield {
                "type": "error",
                "content": str(e)
            }

    def _stream_delegate_to_single_agent(
        self,
        task: str,
        context: AgentContext,
        analysis: Dict[str, Any]
    ) -> Generator[Dict[str, Any], None, None]:
        """流式委托给单个智能体（统一使用子任务事件）"""
        subtasks = analysis.get('subtasks', [])
        preferred_agent = subtasks[0].get('agent') if subtasks else None

        # 🚨 防止死循环：如果推荐的智能体是 master_agent 或为空，说明是通用对话
        if not preferred_agent or preferred_agent == 'master_agent':
            self.logger.info("[MasterAgent] 无需特定智能体，由 MasterAgent 直接处理通用对话")
            # 通用对话也作为一个子任务
            yield {
                "type": "subtask_start",
                "order": 1,
                "agent_name": "master_agent",
                "agent_display_name": "MasterAgent",
                "description": task
            }
            yield from self._stream_general_chat(task, context)
            yield {
                "type": "subtask_end",
                "order": 1,
                "result_summary": ""  # 通用对话没有摘要
            }
            return

        # 发送子任务开始事件
        agent_display_name = self._get_agent_display_name(preferred_agent)
        yield {
            "type": "subtask_start",
            "order": 1,
            "agent_name": preferred_agent,
            "agent_display_name": agent_display_name,
            "description": subtasks[0].get('description', task) if subtasks else task
        }

        # 获取 Agent 实例
        agent = self.orchestrator.agents.get(preferred_agent)

        # 用于收集最终答案
        final_content = ""

        # 检查 Agent 是否支持流式执行
        if agent and hasattr(agent, 'execute_stream'):
            # 使用流式执行，实时转发事件
            self.logger.info(f"[MasterAgent] 使用流式执行 {preferred_agent}")

            for event in agent.execute_stream(task, context):
                if event['type'] == 'final_answer':
                    # 捕获最终答案
                    final_content = event['content']

                    # 🔧 将 final_answer 转换为 chunk
                    # 如果内容是 JSON 对象，包装为 Markdown 代码块
                    chunk_content = event['content']
                    if isinstance(chunk_content, dict) or isinstance(chunk_content, list):
                        import json
                        chunk_content = f"```json\n{json.dumps(chunk_content, ensure_ascii=False, indent=2)}\n```"

                    yield {
                        "type": "chunk",
                        "content": chunk_content
                    }
                else:
                    # 转发其他事件，添加 subtask_order
                    if event['type'] in ['thought_structured', 'tool_start', 'tool_end']:
                        event['subtask_order'] = 1
                    yield event
        else:
            # 降级到非流式执行（使用旧的回调机制）
            self.logger.warning(f"[MasterAgent] Agent {preferred_agent} 不支持流式执行，使用回调模式")

            event_queue = []

            def event_callback(event_type: str, data: Dict[str, Any]):
                if event_type == 'tool_start':
                    event_queue.append({
                        "type": "tool_start",
                        "tool_name": data['tool_name'],
                        "arguments": data['arguments'],
                        "index": data['index'],
                        "total": data['total'],
                        "subtask_order": 1  # 添加子任务标识
                    })
                elif event_type == 'tool_end':
                    event_queue.append({
                        "type": "tool_end",
                        "tool_name": data['tool_name'],
                        "result": data['result'],
                        "elapsed_time": data['elapsed_time'],
                        "index": data['index'],
                        "total": data['total'],
                        "subtask_order": 1  # 添加子任务标识
                    })
                elif event_type == 'thought_structured':
                    event_queue.append({
                        "type": "thought_structured",
                        "thought": data['thought'],
                        "round": data['round'],
                        "has_actions": data['has_actions'],
                        "has_answer": data['has_answer'],
                        "subtask_order": 1  # 添加子任务标识
                    })

            if agent and hasattr(agent, 'event_callback'):
                old_callback = agent.event_callback
                agent.event_callback = event_callback

                response = self.orchestrator.execute(
                    task=task,
                    context=context,
                    preferred_agent=preferred_agent
                )

                agent.event_callback = old_callback

                for event in event_queue:
                    yield event
            else:
                response = self.orchestrator.execute(
                    task=task,
                    context=context,
                    preferred_agent=preferred_agent
                )

            if response.success:
                final_content = response.content

                # 🔧 如果内容是 JSON 对象，包装为 Markdown 代码块
                chunk_content = response.content
                if isinstance(chunk_content, dict) or isinstance(chunk_content, list):
                    import json
                    chunk_content = f"```json\n{json.dumps(chunk_content, ensure_ascii=False, indent=2)}\n```"

                yield {
                    "type": "chunk",
                    "content": chunk_content
                }
            else:
                yield {
                    "type": "error",
                    "content": response.error or "执行失败"
                }
                return

        # 发送子任务结束事件
        # 处理 final_content 可能是字符串或对象的情况
        if isinstance(final_content, str):
            result_summary = final_content[:200] + "..." if len(final_content) > 200 else final_content
        else:
            # 如果是对象（如JSON），转换为字符串后截取
            import json
            content_str = json.dumps(final_content, ensure_ascii=False, indent=2)
            result_summary = content_str[:200] + "..." if len(content_str) > 200 else content_str

        yield {
            "type": "subtask_end",
            "order": 1,
            "result_summary": result_summary
        }

        yield {
            "type": "agent_end",
            "agent": preferred_agent
        }

        # 🎯 为单智能体任务生成 final_answer 事件
        # 确保前端能够显示最终答案
        # yield {
        #     "type": "final_answer",
        #     "content": final_content
        # }

    def _stream_general_chat(self, task: str, context: AgentContext) -> Generator[Dict[str, Any], None, None]:
        """流式通用对话（真流式）"""
        try:
            messages = [
                {"role": "system", "content": "你是一个智能且友好的 AI 助手。请直接回答用户的问题。"},
                {"role": "user", "content": task}
            ]

            llm_config = self.get_llm_config()

            # 使用真正的流式 API
            for chunk in self.llm_adapter.chat_completion_stream(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=0.7,
                max_tokens=llm_config.get('max_tokens', 1000)
            ):
                # 检查是否有错误
                if 'error' in chunk:
                    yield {"type": "error", "content": chunk['error']}
                    break

                # 实时转发内容
                content = chunk.get('content', '')
                if content:  # 只转发非空内容
                    yield {"type": "chunk", "content": content}

                # 检查是否完成
                if chunk.get('finish_reason') in ['stop', 'length']:
                    break

        except Exception as e:
            self.logger.error(f"流式对话失败: {e}")
            yield {"type": "error", "content": str(e)}

    def _stream_coordinate_multiple_agents(
        self,
        task: str,
        context: AgentContext,
        analysis: Dict[str, Any]
    ) -> Generator[Dict[str, Any], None, None]:
        """流式协调多个智能体（使用统一子任务事件）"""
        subtasks = analysis.get('subtasks', [])

        results = []
        subtask_responses = {}

        for subtask in sorted(subtasks, key=lambda x: x.get('order', 0)):
            subtask_desc = subtask.get('description', '')
            agent_name = subtask.get('agent', '')
            depends_on = subtask.get('depends_on', [])
            subtask_order = subtask.get('order')

            # 发送子任务开始事件
            agent_display_name = self._get_agent_display_name(agent_name)
            yield {
                "type": "subtask_start",
                "order": subtask_order,
                "agent_name": agent_name,
                "agent_display_name": agent_display_name,
                "description": subtask_desc
            }

            # 检查依赖并传递前置任务结果
            enhanced_subtask_desc = subtask_desc
            if depends_on:
                dep_results = [
                    subtask_responses.get(dep_order)
                    for dep_order in depends_on
                    if dep_order in subtask_responses
                ]
                context.set_shared_data('previous_results', dep_results)

                # 在子任务描述中增强上下文，明确包含前置任务的结果
                if dep_results:
                    dep_context = "\n\n【前置任务结果】\n"
                    for dep in dep_results:
                        dep_context += f"- 任务: {dep.get('description', '未知')}\n"
                        if dep.get('success'):
                            # 截取合理长度的结果内容
                            dep_content = dep.get('content', '')
                            if len(dep_content) > 1000:
                                dep_content = dep_content[:1000] + "...(内容过长，已截断)"
                            dep_context += f"  结果: {dep_content}\n"
                            # 如果有结构化数据，也传递
                            if dep.get('data'):
                                dep_context += f"  数据: {json.dumps(dep.get('data'), ensure_ascii=False, indent=2)}\n"
                        else:
                            dep_context += f"  失败: {dep.get('error', '未知错误')}\n"
                        dep_context += "\n"

                    enhanced_subtask_desc = f"{subtask_desc}\n{dep_context}"
                    self.logger.info(f"[MasterAgent] 子任务 {subtask_order} 已增强上下文，包含 {len(dep_results)} 个前置任务的结果")

            # 执行子任务，使用流式执行（如果支持）
            try:
                # 获取 agent 实例
                agent = self.orchestrator.agents.get(agent_name)

                # 优先使用流式执行
                if agent and hasattr(agent, 'execute_stream'):
                    self.logger.info(f"[MasterAgent] 使用流式执行子任务: {agent_name}")

                    # 实时转发事件，添加 subtask_order
                    final_content = ""
                    for event in agent.execute_stream(enhanced_subtask_desc, context):
                        if event['type'] == 'final_answer':
                            # 捕获最终答案
                            final_content = event['content']
                            # 不 yield，等待构建 response 后再处理
                        elif event['type'] in ['thought_structured', 'tool_start', 'tool_end']:
                            # 转发其他事件，添加 subtask_order
                            event['subtask_order'] = subtask_order
                            yield event
                        else:
                            # 其他事件直接转发
                            yield event

                    # 构建响应对象（模拟非流式返回）
                    from .base import AgentResponse
                    response = AgentResponse(
                        success=True,
                        content=final_content,
                        agent_name=agent_name,
                        execution_time=0  # 已在事件中报告
                    )
                else:
                    # 降级到非流式执行（使用回调队列）
                    self.logger.warning(f"[MasterAgent] Agent {agent_name} 不支持流式执行，使用回调模式")

                    event_queue = []

                    def event_callback(event_type: str, data: Dict[str, Any]):
                        if event_type == 'tool_start':
                            event_queue.append({
                                "type": "tool_start",
                                "tool_name": data['tool_name'],
                                "arguments": data['arguments'],
                                "index": data['index'],
                                "total": data['total'],
                                "subtask_order": subtask_order  # 添加 subtask_order
                            })
                        elif event_type == 'tool_end':
                            event_queue.append({
                                "type": "tool_end",
                                "tool_name": data['tool_name'],
                                "result": data['result'],
                                "elapsed_time": data['elapsed_time'],
                                "index": data['index'],
                                "total": data['total'],
                                "subtask_order": subtask_order  # 添加 subtask_order
                            })
                        elif event_type == 'thought_structured':
                            event_queue.append({
                                "type": "thought_structured",
                                "thought": data['thought'],
                                "round": data['round'],
                                "has_actions": data['has_actions'],
                                "has_answer": data['has_answer'],
                                "subtask_order": subtask_order  # 添加 subtask_order
                            })

                    if agent and hasattr(agent, 'event_callback'):
                        old_callback = agent.event_callback
                        agent.event_callback = event_callback

                        response = self.orchestrator.execute(
                            task=enhanced_subtask_desc,
                            context=context,
                            preferred_agent=agent_name
                        )

                        agent.event_callback = old_callback

                        # 转发队列中的事件
                        for event in event_queue:
                            yield event
                    else:
                        response = self.orchestrator.execute(
                            task=enhanced_subtask_desc,
                            context=context,
                            preferred_agent=agent_name
                        )

                # 保存结果
                subtask_responses[subtask.get('order')] = {
                    'description': subtask_desc,
                    'agent': response.agent_name,
                    'success': response.success,
                    'content': response.content,
                    'data': response.data,
                    'execution_time': response.execution_time
                }
                results.append(subtask_responses[subtask.get('order')])
                context.store_result(f'subtask_{subtask.get("order")}', response.data)

                # 发送子任务结束事件（返回完整结果，不再截断）
                yield {
                    "type": "subtask_end",
                    "order": subtask_order,
                    "result_summary": response.content  # 返回完整内容，由前端处理展示
                }

            except Exception as e:
                self.logger.error(f"子任务执行失败: {e}")
                results.append({
                    'description': subtask_desc,
                    'agent': agent_name,
                    'success': False,
                    'error': str(e)
                })
                # 发送子任务失败事件
                yield {
                    "type": "subtask_end",
                    "order": subtask_order,
                    "result_summary": f"执行失败: {str(e)}",
                    "success": False
                }

        # 整合结果（使用流式）
        yield {
            "type": "thought",
            "content": "所有子任务完成，正在整合最终结果..."
        }

        # 使用流式整合，实时 yield 每个 token
        for chunk in self._synthesize_results_stream(task, results):
            content = chunk.get('content', '')
            if content:
                yield {
                    "type": "chunk",
                    "content": content
                }

            # 检查是否完成
            if chunk.get('finish_reason') in ['stop', 'length']:
                break

    def _analyze_task(
        self,
        task: str,
        context: AgentContext
    ) -> Optional[Dict[str, Any]]:
        """
        分析任务，判断复杂度和分解方案

        Args:
            task: 用户任务
            context: 上下文

        Returns:
            分析结果字典，包含 complexity, needs_multiple_agents, subtasks 等
        """
        try:
            # 获取可用智能体信息
            agents = self.orchestrator.list_agents()
            agents_info = "\n".join([
                f"- {agent['name']}: {agent['description']}"
                for agent in agents
                if agent['name'] != 'master_agent'  # 排除自己
            ])

            # 构建提示词
            prompt = self.TASK_ANALYSIS_PROMPT.format(
                agents_info=agents_info,
                task=task
            )

            # 调用 LLM 分析
            messages = [
                {"role": "system", "content": "你是一个任务规划专家，擅长分析任务复杂度和制定执行计划。"},
                {"role": "user", "content": prompt}
            ]

            # 获取 LLM 配置（用于任务分析，使用更低的温度）
            llm_config = self.get_llm_config()
            analysis_temperature = self.get_custom_param('analysis_temperature', default=0.0)

            response = self.llm_adapter.chat_completion(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=analysis_temperature,
                max_tokens=llm_config.get('max_tokens', 1000),
                timeout=llm_config.get('timeout'),
                max_retries=llm_config.get('retry_attempts')
            )

            if response.error:
                self.logger.error(f"LLM 分析失败: {response.error}")
                return None

            # 解析 JSON 结果
            content = response.content.strip()

            # 提取 JSON（可能被包裹在代码块中）
            if '```json' in content:
                content = content.split('```json')[1].split('```')[0].strip()
            elif '```' in content:
                content = content.split('```')[1].split('```')[0].strip()

            analysis = json.loads(content)

            self.logger.info(f"[MasterAgent] 任务分析完成: {analysis.get('reasoning', '')}")

            return analysis

        except json.JSONDecodeError as e:
            self.logger.error(f"解析 LLM 响应失败: {e}")
            self.logger.error(f"原始响应: {response.content}")
            return None
        except Exception as e:
            self.logger.error(f"任务分析失败: {e}", exc_info=True)
            return None

    def _delegate_to_single_agent(
        self,
        task: str,
        context: AgentContext,
        analysis: Dict[str, Any]
    ) -> AgentResponse:
        """
        委托给单个智能体执行
        """
        self.logger.info("[MasterAgent] 任务较简单，委托给单个智能体")

        # 从分析结果获取推荐的智能体
        subtasks = analysis.get('subtasks', [])
        preferred_agent = subtasks[0].get('agent') if subtasks else None

        # 🚨 防止死循环：如果推荐的智能体是 master_agent 或为空，说明是通用对话，直接由 MasterAgent 回答
        if not preferred_agent or preferred_agent == 'master_agent':
            self.logger.info("[MasterAgent] 无需特定智能体，由 MasterAgent 直接处理通用对话")
            return self._handle_general_chat(task, context)

        # 执行任务
        response = self.orchestrator.execute(
            task=task,
            context=context,
            preferred_agent=preferred_agent
        )

        # 添加 MasterAgent 的元数据
        response.metadata['delegated_by'] = 'master_agent'
        response.metadata['complexity'] = analysis.get('complexity', 'simple')

        return response

    def _handle_general_chat(self, task: str, context: AgentContext) -> AgentResponse:
        """
        处理通用对话任务（不涉及具体智能体）
        """
        try:
            messages = [
                {"role": "system", "content": "你是一个智能且友好的 AI 助手。请直接回答用户的问题。"},
                {"role": "user", "content": task}
            ]

            llm_config = self.get_llm_config()

            response = self.llm_adapter.chat_completion(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=0.7,
                max_tokens=llm_config.get('max_tokens', 1000)
            )

            if response.error:
                return AgentResponse(success=False, error=response.error, agent_name=self.name)

            return AgentResponse(
                success=True,
                content=response.content,
                agent_name=self.name,
                metadata={'type': 'general_chat'}
            )

        except Exception as e:
            self.logger.error(f"通用对话处理失败: {e}")
            return AgentResponse(success=False, error=str(e), agent_name=self.name)

    def _coordinate_multiple_agents(
        self,
        task: str,
        context: AgentContext,
        analysis: Dict[str, Any]
    ) -> AgentResponse:
        """
        协调多个智能体执行复杂任务

        Args:
            task: 原始任务
            context: 上下文
            analysis: 任务分析结果

        Returns:
            AgentResponse
        """
        start_time = time.time()

        self.logger.info("[MasterAgent] 任务复杂，开始协调多个智能体")

        subtasks = analysis.get('subtasks', [])
        if not subtasks:
            return AgentResponse(
                success=False,
                error="任务分解失败，未生成子任务",
                agent_name=self.name
            )

        # 按顺序执行子任务
        results = []
        subtask_responses = {}

        for subtask in sorted(subtasks, key=lambda x: x.get('order', 0)):
            subtask_desc = subtask.get('description', '')
            agent_name = subtask.get('agent', '')
            depends_on = subtask.get('depends_on', [])

            self.logger.info(f"[MasterAgent] 执行子任务 {subtask.get('order')}: {subtask_desc}")

            # 检查依赖并传递前置任务结果
            enhanced_subtask_desc = subtask_desc
            if depends_on:
                # 将依赖任务的结果添加到上下文
                dep_results = [
                    subtask_responses.get(dep_order)
                    for dep_order in depends_on
                    if dep_order in subtask_responses
                ]
                context.set_shared_data('previous_results', dep_results)

                # 在子任务描述中增强上下文，明确包含前置任务的结果
                if dep_results:
                    dep_context = "\n\n【前置任务结果】\n"
                    for dep in dep_results:
                        dep_context += f"- 任务: {dep.get('description', '未知')}\n"
                        if dep.get('success'):
                            # 截取合理长度的结果内容
                            dep_content = dep.get('content', '')
                            if len(dep_content) > 1000:
                                dep_content = dep_content[:1000] + "...(内容过长，已截断)"
                            dep_context += f"  结果: {dep_content}\n"
                            # 如果有结构化数据，也传递
                            if dep.get('data'):
                                dep_context += f"  数据: {json.dumps(dep.get('data'), ensure_ascii=False, indent=2)}\n"
                        else:
                            dep_context += f"  失败: {dep.get('error', '未知错误')}\n"
                        dep_context += "\n"

                    enhanced_subtask_desc = f"{subtask_desc}\n{dep_context}"
                    self.logger.info(f"[MasterAgent] 子任务 {subtask.get('order')} 已增强上下文，包含 {len(dep_results)} 个前置任务的结果")

            # 执行子任务（使用增强后的描述）
            try:
                response = self.orchestrator.execute(
                    task=enhanced_subtask_desc,
                    context=context,
                    preferred_agent=agent_name
                )

                # 保存结果
                subtask_responses[subtask.get('order')] = {
                    'description': subtask_desc,
                    'agent': response.agent_name,
                    'success': response.success,
                    'content': response.content,
                    'data': response.data,
                    'execution_time': response.execution_time
                }

                results.append(subtask_responses[subtask.get('order')])

                # 将结果存储到上下文，供后续任务使用
                context.store_result(f'subtask_{subtask.get("order")}', response.data)

            except Exception as e:
                self.logger.error(f"子任务执行失败: {e}")
                results.append({
                    'description': subtask_desc,
                    'agent': agent_name,
                    'success': False,
                    'error': str(e)
                })

        # 整合结果
        self.logger.info("[MasterAgent] 所有子任务完成，开始整合结果")
        final_answer = self._synthesize_results(task, results)

        execution_time = time.time() - start_time

        return AgentResponse(
            success=True,
            content=final_answer,
            data={
                'subtasks': results,
                'analysis': analysis,
                'total_subtasks': len(subtasks)
            },
            metadata={
                'complexity': analysis.get('complexity'),
                'subtasks_count': len(subtasks),
                'reasoning': analysis.get('reasoning', '')
            },
            agent_name=self.name,
            execution_time=execution_time
        )

    def _synthesize_results(
        self,
        original_task: str,
        results: List[Dict[str, Any]]
    ) -> str:
        """
        整合多个智能体的结果为统一答案（非流式版本）

        Args:
            original_task: 原始任务
            results: 各子任务的执行结果

        Returns:
            整合后的答案
        """
        try:
            # 格式化结果
            results_text = ""
            for i, result in enumerate(results, 1):
                results_text += f"\n子任务 {i}: {result.get('description', '')}\n"
                results_text += f"执行智能体: {result.get('agent', '')}\n"
                if result.get('success'):
                    results_text += f"结果: {result.get('content', '')[:500]}...\n"
                else:
                    results_text += f"失败: {result.get('error', '')}\n"
                results_text += "-" * 50 + "\n"

            # 构建提示词
            prompt = self.RESULT_SYNTHESIS_PROMPT.format(
                task=original_task,
                results=results_text
            )

            # 调用 LLM 整合
            messages = [
                {"role": "system", "content": "你是一个结果整合专家，擅长将多个信息源整合为连贯的回答。"},
                {"role": "user", "content": prompt}
            ]

            # 获取 LLM 配置（用于结果整合，使用稍高的温度）
            llm_config = self.get_llm_config()
            synthesis_temperature = self.get_custom_param('synthesis_temperature', default=0.3)

            response = self.llm_adapter.chat_completion(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=synthesis_temperature,
                max_tokens=llm_config.get('max_tokens', 2000),
                timeout=llm_config.get('timeout'),
                max_retries=llm_config.get('retry_attempts')
            )

            if response.error:
                self.logger.error(f"结果整合失败: {response.error}")
                # 降级方案：简单拼接
                return self._simple_synthesis(results)

            return response.content

        except Exception as e:
            self.logger.error(f"结果整合异常: {e}", exc_info=True)
            return self._simple_synthesis(results)

    def _synthesize_results_stream(
        self,
        original_task: str,
        results: List[Dict[str, Any]]
    ):
        """
        流式整合多个智能体的结果为统一答案（生成器版本）

        Args:
            original_task: 原始任务
            results: 各子任务的执行结果

        Yields:
            Dict[str, Any]: 流式数据块 {"content": "...", "finish_reason": "..."}
        """
        try:
            # 格式化结果
            results_text = ""
            for i, result in enumerate(results, 1):
                results_text += f"\n子任务 {i}: {result.get('description', '')}\n"
                results_text += f"执行智能体: {result.get('agent', '')}\n"
                if result.get('success'):
                    results_text += f"结果: {result.get('content', '')[:500]}...\n"
                else:
                    results_text += f"失败: {result.get('error', '')}\n"
                results_text += "-" * 50 + "\n"

            # 构建提示词
            prompt = self.RESULT_SYNTHESIS_PROMPT.format(
                task=original_task,
                results=results_text
            )

            # 调用 LLM 流式整合
            messages = [
                {"role": "system", "content": "你是一个结果整合专家，擅长将多个信息源整合为连贯的回答。"},
                {"role": "user", "content": prompt}
            ]

            # 获取 LLM 配置（用于结果整合，使用稍高的温度）
            llm_config = self.get_llm_config()
            synthesis_temperature = self.get_custom_param('synthesis_temperature', default=0.3)

            # 使用流式 API
            for chunk in self.llm_adapter.chat_completion_stream(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=synthesis_temperature,
                max_tokens=llm_config.get('max_tokens', 2000)
            ):
                # 检查错误
                if 'error' in chunk:
                    self.logger.error(f"结果整合失败: {chunk['error']}")
                    # 降级方案：返回简单拼接
                    yield {"content": self._simple_synthesis(results), "finish_reason": "stop"}
                    break

                # 转发内容
                content = chunk.get('content', '')
                if content:
                    yield {"content": content, "finish_reason": chunk.get('finish_reason')}

                # 检查是否完成
                if chunk.get('finish_reason') in ['stop', 'length']:
                    break

        except Exception as e:
            self.logger.error(f"流式结果整合异常: {e}", exc_info=True)
            # 降级方案：返回简单拼接
            yield {"content": self._simple_synthesis(results), "finish_reason": "stop"}

    def _simple_synthesis(self, results: List[Dict[str, Any]]) -> str:
        """
        简单的结果拼接（降级方案）

        Args:
            results: 各子任务结果

        Returns:
            拼接的答案
        """
        answer = "以下是各部分的执行结果：\n\n"

        for i, result in enumerate(results, 1):
            answer += f"**{i}. {result.get('description', '')}**\n"
            if result.get('success'):
                answer += f"{result.get('content', '')}\n\n"
            else:
                answer += f"执行失败: {result.get('error', '')}\n\n"

        return answer
