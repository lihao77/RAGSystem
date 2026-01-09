# -*- coding: utf-8 -*-
"""
混合调度器 - MasterAgent V2 核心组件 (第1部分)

负责执行计划的调度和执行:
1. 直接回答执行
2. 静态 DAG 执行
3. 混合模式执行 (静态+动态)
"""

import asyncio
import logging
import json
import time
from typing import Dict, Any, List, Optional, AsyncGenerator
from ..base import AgentResponse
from .enhanced_context import EnhancedAgentContext
from .execution_plan import (
    ExecutionPlan,
    DirectAnswerPlan,
    StaticExecutionPlan,
    HybridExecutionPlan,
    TaskNode,
    Stage
)
from .failure_handler import FailureHandler

logger = logging.getLogger(__name__)


class HybridScheduler:
    """
    混合模式调度器

    支持三种执行模式:
    1. 直接回答 (DirectAnswerPlan)
    2. 静态 DAG (StaticExecutionPlan)
    3. 混合模式 (HybridExecutionPlan)
    """

    def __init__(self, orchestrator, master_agent):
        """
        初始化调度器

        Args:
            orchestrator: 智能体编排器
            master_agent: MasterAgent 实例
        """
        self.orchestrator = orchestrator
        self.master_agent = master_agent
        self.llm_adapter = master_agent.llm_adapter
        self.failure_handler = FailureHandler(orchestrator, master_agent)

    async def execute_plan(
        self,
        plan: ExecutionPlan,
        context: EnhancedAgentContext
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        执行计划（流式）

        Args:
            plan: 执行计划
            context: 增强上下文

        Yields:
            执行事件流
        """
        if isinstance(plan, DirectAnswerPlan):
            async for event in self._execute_direct_answer(plan, context):
                yield event

        elif isinstance(plan, StaticExecutionPlan):
            async for event in self._execute_static_plan(plan, context):
                yield event

        elif isinstance(plan, HybridExecutionPlan):
            async for event in self._execute_hybrid_plan(plan, context):
                yield event

        else:
            raise ValueError(f"不支持的计划类型: {type(plan)}")

    # ========== 直接回答执行 ==========

    async def _execute_direct_answer(
        self,
        plan: DirectAnswerPlan,
        context: EnhancedAgentContext
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        执行直接回答计划

        Args:
            plan: 直接回答计划
            context: 上下文

        Yields:
            事件流
        """
        # 记录执行路径
        context.record_execution_step({
            'type': 'direct_answer',
            'reasoning': plan.reasoning
        })

        # 模拟流式输出（分块）
        answer = plan.answer
        chunk_size = 20  # 每块20个字符

        for i in range(0, len(answer), chunk_size):
            chunk = answer[i:i+chunk_size]
            yield {
                "type": "chunk",
                "content": chunk
            }
            # 模拟延迟
            await asyncio.sleep(0.01)

    # ========== 静态 DAG 执行 ==========

    async def _execute_static_plan(
        self,
        plan: StaticExecutionPlan,
        context: EnhancedAgentContext
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        执行静态 DAG 计划

        Args:
            plan: 静态执行计划
            context: 上下文

        Yields:
            事件流
        """
        # 记录执行路径
        context.record_execution_step({
            'type': 'static_plan',
            'strategy': plan.strategy,
            'total_tasks': len(plan.tasks)
        })

        # 拓扑排序
        try:
            layers = plan._topological_sort()
        except ValueError as e:
            yield {
                "type": "error",
                "content": f"任务依赖关系错误: {e}"
            }
            return

        logger.info(f"静态计划分为 {len(layers)} 层执行")

        # 逐层执行
        for layer_idx, layer in enumerate(layers):
            yield {
                "type": "layer_start",
                "layer": layer_idx,
                "task_count": len(layer),
                "tasks": [
                    {"id": t.id, "agent": t.agent, "description": t.description[:50]}
                    for t in layer
                ]
            }

            # 并行执行该层任务
            if plan.strategy == 'parallel' and len(layer) > 1:
                async for event in self._execute_layer_parallel(layer, context):
                    yield event
            else:
                # 串行执行
                for task_node in layer:
                    async for event in self._execute_single_task(task_node, context):
                        yield event

            yield {
                "type": "layer_complete",
                "layer": layer_idx
            }

    async def _execute_layer_parallel(
        self,
        layer: List[TaskNode],
        context: EnhancedAgentContext
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        并行执行一层任务

        Args:
            layer: 任务节点列表
            context: 上下文

        Yields:
            事件流
        """
        logger.info(f"并行执行 {len(layer)} 个任务")

        # 创建异步任务
        tasks = []
        for task_node in layer:
            task = asyncio.create_task(
                self._execute_single_task_collect(task_node, context)
            )
            tasks.append((task_node, task))

        # 等待所有任务完成，实时转发事件
        pending = {task for _, task in tasks}

        while pending:
            done, pending = await asyncio.wait(
                pending,
                return_when=asyncio.FIRST_COMPLETED
            )

            for completed_task in done:
                # 获取结果（事件列表）
                events = await completed_task

                # 转发事件
                for event in events:
                    yield event

    async def _execute_single_task_collect(
        self,
        task_node: TaskNode,
        context: EnhancedAgentContext
    ) -> List[Dict[str, Any]]:
        """
        执行单个任务并收集所有事件（用于并行）

        Args:
            task_node: 任务节点
            context: 上下文

        Returns:
            事件列表
        """
        events = []
        async for event in self._execute_single_task(task_node, context):
            events.append(event)
        return events

    async def _execute_single_task(
        self,
        task_node: TaskNode,
        context: EnhancedAgentContext
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        执行单个任务（流式）

        Args:
            task_node: 任务节点
            context: 上下文

        Yields:
            事件流
        """
        task_id = task_node.id
        agent_name = task_node.agent
        description = task_node.description

        # 发送任务开始事件
        yield {
            "type": "subtask_start",
            "task_id": task_id,
            "agent": agent_name,
            "description": description
        }

        # 记录执行路径
        context.record_execution_step({
            'type': 'task_execute',
            'task_id': task_id,
            'agent': agent_name
        })

        try:
            # 获取依赖数据
            dep_data = context.get_dependency_data(task_node.depends_on)

            # 构建增强的任务描述（注入依赖数据）
            enhanced_task = self._build_enhanced_task_prompt(
                description,
                dep_data
            )

            # 执行任务
            agent = self.orchestrator.agents.get(agent_name)

            if not agent:
                raise ValueError(f"智能体 {agent_name} 不存在")

            # 尝试流式执行
            if hasattr(agent, 'execute_stream'):
                logger.info(f"使用流式执行任务 {task_id}")

                final_content = ""
                final_data = None

                # 获取 execute_stream 的结果
                stream_result = agent.execute_stream(enhanced_task, context)

                # 检查是否是异步生成器
                import inspect
                if inspect.isasyncgen(stream_result):
                    # 异步生成器，直接使用 async for
                    async for event in stream_result:
                        # 添加 task_id 标识
                        event['task_id'] = task_id

                        # 捕获最终答案
                        if event.get('type') == 'final_answer':
                            final_content = event.get('content', '')
                            final_data = event.get('data')

                        yield event
                else:
                    # 同步生成器，需要适配
                    for event in stream_result:
                        # 添加 task_id 标识
                        event['task_id'] = task_id

                        # 捕获最终答案
                        if event.get('type') == 'final_answer':
                            final_content = event.get('content', '')
                            final_data = event.get('data')

                        yield event
                        # 在同步循环中让出控制权
                        await asyncio.sleep(0)

                result_data = {
                    "content": final_content,
                    "data": final_data
                }

            else:
                # 降级到非流式执行
                logger.info(f"使用非流式执行任务 {task_id}")

                response = await asyncio.to_thread(
                    self.orchestrator.execute,
                    task=enhanced_task,
                    context=context,
                    preferred_agent=agent_name
                )

                result_data = {
                    "content": response.content,
                    "data": response.data
                }

                # 发送内容
                yield {
                    "type": "chunk",
                    "task_id": task_id,
                    "content": response.content
                }

            # 存储结果
            context.store_task_result(
                task_id,
                result_data,
                success=True,
                auto_summarize=True
            )

            # 增加统计
            context.increment_tool_calls()

            # 发送任务完成事件
            yield {
                "type": "subtask_end",
                "task_id": task_id,
                "success": True,
                "result_summary": result_data['content'][:200] if result_data['content'] else ""
            }

        except Exception as e:
            logger.error(f"任务 {task_id} 执行失败: {e}", exc_info=True)

            # 发送失败事件
            yield {
                "type": "subtask_end",
                "task_id": task_id,
                "success": False,
                "error": str(e)
            }

            # 使用失败处理器
            recovery_response = self.failure_handler.handle_failure(
                task_node,
                context,
                e
            )

            if recovery_response and recovery_response.success:
                # 恢复成功，存储结果
                context.store_task_result(
                    task_id,
                    {
                        "content": recovery_response.content,
                        "data": recovery_response.data
                    },
                    success=True,
                    auto_summarize=True
                )

                yield {
                    "type": "subtask_recovered",
                    "task_id": task_id,
                    "strategy": task_node.fallback_strategy.value,
                    "content": recovery_response.content[:200]
                }
            else:
                # 恢复失败，记录失败
                context.store_task_result(
                    task_id,
                    {"error": str(e)},
                    success=False,
                    error=str(e),
                    auto_summarize=False
                )

    def _build_enhanced_task_prompt(
        self,
        description: str,
        dep_data: Dict[str, Any]
    ) -> str:
        """
        构建增强的任务描述（注入依赖数据）

        Args:
            description: 原始任务描述
            dep_data: 依赖数据

        Returns:
            增强的任务描述
        """
        if not dep_data:
            return description

        # 构建依赖信息
        dep_info_parts = []
        for task_id, data_wrapper in dep_data.items():
            if data_wrapper.get('is_summary'):
                dep_info_parts.append(
                    f"**{task_id}** (摘要):\n{data_wrapper['summary']}"
                )
            else:
                data = data_wrapper['data']
                # 控制数据长度
                data_str = json.dumps(data, ensure_ascii=False, indent=2)
                if len(data_str) > 1000:
                    data_str = data_str[:1000] + "\n... (数据已截断)"
                dep_info_parts.append(
                    f"**{task_id}**:\n{data_str}"
                )

        dep_info = "\n\n".join(dep_info_parts)

        enhanced_prompt = f"""{description}

---
**依赖任务结果**:

{dep_info}

---

请基于以上依赖数据完成任务。
"""

        return enhanced_prompt

    # ========== 混合模式执行 ==========

    async def _execute_hybrid_plan(
        self,
        plan: HybridExecutionPlan,
        context: EnhancedAgentContext
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        执行混合模式计划 (宏观静态 + 微观动态)

        Args:
            plan: 混合执行计划
            context: 上下文

        Yields:
            事件流
        """
        # 记录执行路径
        context.record_execution_step({
            'type': 'hybrid_plan',
            'total_stages': len(plan.stages)
        })

        # 拓扑排序阶段
        try:
            sorted_stages = plan._topological_sort_stages()
        except ValueError as e:
            yield {
                "type": "error",
                "content": f"阶段依赖关系错误: {e}"
            }
            return

        logger.info(f"混合计划包含 {len(sorted_stages)} 个阶段")

        # 逐阶段执行
        for stage_idx, stage in enumerate(sorted_stages):
            yield {
                "type": "stage_start",
                "stage_id": stage.stage_id,
                "stage_name": stage.name,
                "stage_type": stage.type,
                "stage_index": stage_idx,
                "total_stages": len(sorted_stages)
            }

            if stage.type == 'static':
                # 静态阶段: 预定义任务
                async for event in self._execute_stage_static(stage, context):
                    event['stage_id'] = stage.stage_id
                    yield event

            elif stage.type == 'dynamic':
                # 动态阶段: ReAct 模式
                async for event in self._execute_stage_dynamic(stage, context):
                    event['stage_id'] = stage.stage_id
                    yield event

            else:
                logger.error(f"未知的阶段类型: {stage.type}")
                continue

            # 获取阶段输出
            stage_output = context.stage_outputs.get(stage.stage_id)

            yield {
                "type": "stage_complete",
                "stage_id": stage.stage_id,
                "stage_name": stage.name,
                "output_summary": str(stage_output.output)[:200] if stage_output else ""
            }

    async def _execute_stage_static(
        self,
        stage: Stage,
        context: EnhancedAgentContext
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        执行静态阶段

        Args:
            stage: 阶段对象
            context: 上下文

        Yields:
            事件流
        """
        logger.info(f"执行静态阶段: {stage.name}, 包含 {len(stage.subtasks)} 个任务")

        completed_tasks = []

        # 拓扑排序任务
        task_dict = {t.id: t for t in stage.subtasks}
        in_degree = {t.id: len(t.depends_on) for t in stage.subtasks}

        while len(completed_tasks) < len(stage.subtasks):
            # 找出入度为 0 的任务
            ready_tasks = [
                task_dict[tid] for tid, degree in in_degree.items()
                if degree == 0 and tid not in completed_tasks
            ]

            if not ready_tasks:
                # 检查是否还有未完成任务
                remaining = set(task_dict.keys()) - set(completed_tasks)
                if remaining:
                    logger.error(f"静态阶段检测到循环依赖: {remaining}")
                    break
                else:
                    break

            # 执行当前就绪任务
            for task_node in ready_tasks:
                async for event in self._execute_single_task(task_node, context):
                    yield event

                completed_tasks.append(task_node.id)

                # 更新依赖任务的入度
                for other_task in stage.subtasks:
                    if task_node.id in other_task.depends_on:
                        in_degree[other_task.id] -= 1

        # 收集阶段输出
        stage_results = {
            tid: context.task_results.get(tid)
            for tid in completed_tasks
            if context.task_results.get(tid)
        }

        context.store_stage_output(
            stage_id=stage.stage_id,
            stage_name=stage.name,
            output=stage_results,
            tasks_completed=completed_tasks,
            success=True
        )

    async def _execute_stage_dynamic(
        self,
        stage: Stage,
        context: EnhancedAgentContext
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        执行动态阶段 (ReAct 模式)

        MasterAgent 动态决策调用哪个 sub-agent

        Args:
            stage: 阶段对象
            context: 上下文

        Yields:
            事件流
        """
        logger.info(
            f"执行动态阶段: {stage.name}, "
            f"最大轮数: {stage.max_rounds}, "
            f"可用智能体: {stage.available_agents}"
        )

        max_rounds = stage.max_rounds
        available_agents = stage.available_agents
        goal = stage.goal

        # 构建动态执行的 prompt
        agents_info = []
        for agent_name in available_agents:
            agent = self.orchestrator.agents.get(agent_name)
            if agent:
                info = agent.get_info()
                agents_info.append(
                    f"- {agent_name}: {info.get('description', '')}"
                )

        agents_desc = "\n".join(agents_info)

        dynamic_prompt = f"""
你正在执行一个动态阶段，需要通过 ReAct 循环逐步完成目标。

**阶段名称**: {stage.name}
**阶段目标**: {goal}

**可用智能体**:
{agents_desc}

**你的任务**:
1. 思考: 分析当前状态，决定下一步行动
2. 行动: 调用一个或多个智能体完成特定任务
3. 观察: 分析执行结果
4. 判断: 是否达成阶段目标

**输出 JSON 格式**:
{{
  "thought": "当前思考过程",
  "actions": [
    {{"agent": "agent_name", "task": "具体任务描述"}}
  ],
  "goal_achieved": true/false,
  "stage_output": "阶段输出(如果目标达成)"
}}

**重要**:
- actions 可以包含多个并行的智能体调用
- goal_achieved 为 true 时必须提供 stage_output
- 如果已经有足够信息，尽快达成目标

只返回 JSON。
"""

        messages = [
            {"role": "system", "content": dynamic_prompt},
            {"role": "user", "content": f"开始执行阶段: {stage.name}"}
        ]

        # 添加前置阶段的输出
        if stage.depends_on:
            dep_outputs = context.get_stage_dependency_data(stage.depends_on)
            if dep_outputs:
                messages.append({
                    "role": "user",
                    "content": f"前置阶段输出:\n{json.dumps(dep_outputs, ensure_ascii=False, indent=2)}"
                })

        round_num = 0
        observations_history = []

        while round_num < max_rounds:
            round_num += 1

            yield {
                "type": "dynamic_round_start",
                "round": round_num,
                "max_rounds": max_rounds
            }

            # 调用 LLM 决策
            try:
                llm_config = self.master_agent.get_llm_config()
                response = self.llm_adapter.chat_completion(
                    messages=messages,
                    provider=llm_config['provider'],
                    model=llm_config['model_name'],
                    temperature=0.3,
                    response_format={"type": "json_object"}
                )

                # 记录 LLM 调用
                context.increment_llm_calls()

                # 解析 JSON
                content = response.content.strip()
                if '```json' in content:
                    content = content.split('```json')[1].split('```')[0].strip()
                elif '```' in content:
                    content = content.split('```')[1].split('```')[0].strip()

                decision = json.loads(content)

            except Exception as e:
                logger.error(f"动态阶段 LLM 调用失败: {e}")
                yield {
                    "type": "error",
                    "content": f"决策失败: {e}"
                }
                break

            # 发送思考
            yield {
                "type": "dynamic_thought",
                "round": round_num,
                "thought": decision.get('thought', '')
            }

            # 检查是否达成目标
            if decision.get('goal_achieved'):
                stage_output = decision.get('stage_output', '')

                yield {
                    "type": "dynamic_complete",
                    "stage_output": stage_output
                }

                # 存储阶段输出
                context.store_stage_output(
                    stage_id=stage.stage_id,
                    stage_name=stage.name,
                    output={
                        'final_output': stage_output,
                        'observations': observations_history
                    },
                    tasks_completed=[],
                    success=True
                )

                logger.info(f"动态阶段 {stage.name} 完成，共 {round_num} 轮")
                break

            # 执行动作
            actions = decision.get('actions', [])
            if not actions:
                logger.warning(f"第 {round_num} 轮没有动作，继续")
                messages.append({
                    "role": "assistant",
                    "content": response.content
                })
                messages.append({
                    "role": "user",
                    "content": "你没有提供任何动作，请重新思考并提供具体的智能体调用。"
                })
                continue

            observations = []

            for action_idx, action in enumerate(actions):
                agent_name = action.get('agent', '')
                task_desc = action.get('task', '')

                if not agent_name or not task_desc:
                    logger.warning(f"动作 {action_idx} 缺少 agent 或 task")
                    continue

                # 发送动作事件
                yield {
                    "type": "dynamic_action",
                    "round": round_num,
                    "action_index": action_idx,
                    "agent": agent_name,
                    "task": task_desc
                }

                # 调用智能体
                try:
                    agent_response = await asyncio.to_thread(
                        self.orchestrator.execute,
                        task=task_desc,
                        context=context,
                        preferred_agent=agent_name
                    )

                    observation = {
                        "agent": agent_name,
                        "task": task_desc,
                        "success": agent_response.success,
                        "result": agent_response.content[:500]  # 限制长度
                    }

                    if not agent_response.success:
                        observation['error'] = agent_response.error

                    observations.append(observation)

                    # 增加统计
                    context.increment_tool_calls()

                except Exception as e:
                    logger.error(f"动作执行失败: {e}")
                    observations.append({
                        "agent": agent_name,
                        "task": task_desc,
                        "success": False,
                        "error": str(e)
                    })

            # 保存观察历史
            observations_history.extend(observations)

            # 将观察结果反馈给 LLM
            messages.append({
                "role": "assistant",
                "content": response.content
            })
            messages.append({
                "role": "user",
                "content": f"观察结果:\n{json.dumps(observations, ensure_ascii=False, indent=2)}"
            })

            yield {
                "type": "dynamic_round_end",
                "round": round_num,
                "observations_count": len(observations)
            }

        # 超过最大轮数
        if round_num >= max_rounds:
            logger.warning(f"动态阶段 {stage.name} 达到最大轮数 {max_rounds}")

            yield {
                "type": "dynamic_max_rounds",
                "message": f"达到最大轮数 {max_rounds}，强制结束阶段",
                "observations": observations_history
            }

            # 尝试从观察历史中提取输出
            fallback_output = {
                'completed_rounds': round_num,
                'observations': observations_history,
                'status': 'max_rounds_reached'
            }

            context.store_stage_output(
                stage_id=stage.stage_id,
                stage_name=stage.name,
                output=fallback_output,
                tasks_completed=[],
                success=False
            )
