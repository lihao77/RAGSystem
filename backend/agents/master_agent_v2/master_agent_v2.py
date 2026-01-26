# -*- coding: utf-8 -*-
"""
MasterAgent V2 - 增强的主协调智能体

核心改进：
1. ✅ DAG 执行引擎 - 支持并行执行
2. ✅ 增强的上下文管理 - 结构化上下文传递
3. ✅ 失败处理与重试 - 自动重试机制
4. ✅ 执行计划可视化 - DAG 可视化数据
5. ✅ 流式状态更新 - 实时进度反馈
"""

import logging
import json
import time
from typing import Dict, List, Any, Optional, Generator

from agents.base import BaseAgent, AgentContext, AgentResponse
from .execution_plan import ExecutionPlan, SubTask, TaskStatus, ExecutionMode
from .enhanced_context import EnhancedContext, TaskResult
from .dag_executor import DAGExecutor

logger = logging.getLogger(__name__)


class MasterAgentV2(BaseAgent):
    """
    MasterAgent V2 - 增强的主协调智能体

    改进点：
    1. DAG 执行引擎 - 支持任务并行执行
    2. 增强的上下文管理 - 结构化上下文传递，避免字符串拼接
    3. 失败处理与重试 - 子任务失败自动重试
    4. 执行计划可视化 - 生成 DAG 可视化数据
    5. 流式状态更新 - 实时任务进度和状态
    """

    # 任务分析提示词
    TASK_ANALYSIS_PROMPT = """你是一个任务规划专家。分析用户的任务，判断复杂度并制定执行计划。

可用智能体：
{agents_info}

请分析以下任务：
"{task}"

你需要判断：
1. 执行模式（simple/sequential/parallel/dag）
   - simple: 单个智能体直接处理
   - sequential: 多个步骤，必须按顺序执行
   - parallel: 多个独立步骤，可以并行执行
   - dag: 复杂的依赖关系，需要 DAG 执行

2. 子任务分解
   - 每个子任务必须指定使用的智能体
   - 明确标注依赖关系（depends_on）

请以 JSON 格式返回：
{{
  "mode": "simple|sequential|parallel|dag",
  "reasoning": "你的分析理由",
  "subtasks": [
    {{
      "id": "task_1",
      "order": 1,
      "description": "子任务描述",
      "agent_name": "智能体名称",
      "depends_on": []
    }}
  ]
}}

**重要规则：**
- subtasks 数组不能为空
- 如果是 simple 模式，只需 1 个子任务
- 每个子任务必须有唯一的 id（如 "task_1", "task_2"）
- depends_on 使用任务 ID，不是 order

**示例1：简单任务**
输入: "查询南宁2023年洪涝灾害数据"
输出:
{{
  "mode": "simple",
  "reasoning": "单一查询任务，qa_agent 可以直接完成",
  "subtasks": [
    {{
      "id": "task_1",
      "order": 1,
      "description": "查询南宁2023年洪涝灾害数据",
      "agent_name": "qa_agent",
      "depends_on": []
    }}
  ]
}}

**示例2：问候/闲聊**
输入: "你好"
输出:
{{
  "mode": "simple",
  "reasoning": "这是简单的问候，不需要调用专业智能体，master_agent 直接回复即可",
  "subtasks": [
    {{
      "id": "task_1",
      "order": 1,
      "description": "回复用户问候",
      "agent_name": "master_agent_v2",
      "depends_on": []
    }}
  ]
}}

**示例3：并行任务**
输入: "查询广西2023年和2024年的台风数据，并对比分析"
输出:
{{
  "mode": "parallel",
  "reasoning": "2023和2024年的数据查询可以并行，然后再对比",
  "subtasks": [
    {{
      "id": "task_1",
      "order": 1,
      "description": "查询广西2023年台风数据",
      "agent_name": "qa_agent",
      "depends_on": []
    }},
    {{
      "id": "task_2",
      "order": 1,
      "description": "查询广西2024年台风数据",
      "agent_name": "qa_agent",
      "depends_on": []
    }},
    {{
      "id": "task_3",
      "order": 2,
      "description": "对比分析2023和2024年台风数据",
      "agent_name": "qa_agent",
      "depends_on": ["task_1", "task_2"]
    }}
  ]
}}

**注意：如果任务是问候、闲聊或不需要专业知识的通用对话，agent_name 必须设为 "master_agent_v2"**

只返回 JSON，不要有其他内容。
"""

    # 结果整合提示词
    RESULT_SYNTHESIS_PROMPT = """你是一个结果整合专家。将多个智能体的执行结果整合为一个完整的回答。

原始任务：
"{task}"

各智能体执行结果：
{results}

请整合以上结果，生成一个完整、连贯的回答。要求：
1. 逻辑清晰，结构合理
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
        初始化 MasterAgent V2

        Args:
            llm_adapter: LLM 适配器
            orchestrator: 智能体编排器
            agent_config: 智能体配置
            system_config: 系统配置
        """
        super().__init__(
            name='master_agent_v2',
            description='MasterAgent V2 - 支持并行执行的增强版主协调智能体',
            capabilities=[
                'task_analysis',
                'dag_execution',
                'parallel_execution',
                'failure_retry',
                'context_management'
            ],
            llm_adapter=llm_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.orchestrator = orchestrator

        # 创建 DAG 执行器
        self.dag_executor = DAGExecutor(
            orchestrator=orchestrator,
            max_workers=3,  # 最多3个任务并行
            max_retries=1,  # 失败重试1次
            retry_delay=1.0  # 重试延迟1秒
        )

        logger.info("MasterAgent V2 初始化完成")

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """判断是否能处理该任务（处理所有任务）"""
        return True

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """
        执行任务（非流式）

        Args:
            task: 用户任务
            context: 智能体上下文

        Returns:
            AgentResponse
        """
        start_time = time.time()

        try:
            # 1. 分析任务并生成执行计划
            logger.info(f"[MasterAgent V2] 开始分析任务: {task}")
            plan = self._analyze_and_plan(task, context)

            if not plan:
                return AgentResponse(
                    success=False,
                    error="任务分析失败",
                    agent_name=self.name
                )

            # 2. 创建增强上下文
            enhanced_ctx = EnhancedContext(session_id=context.session_id)

            # 3. 执行计划
            logger.info(f"[MasterAgent V2] 执行模式: {plan.mode.value}")
            execution_result = self.dag_executor.execute_plan(
                plan=plan,
                context=enhanced_ctx,
                agent_context=context
            )

            # 4. 整合结果
            if plan.mode == ExecutionMode.SIMPLE:
                # 单智能体，直接返回结果
                if plan.subtasks and plan.subtasks[0].result:
                    task_result = enhanced_ctx.get_task_result(plan.subtasks[0].id)
                    final_content = task_result.content if task_result else "执行完成"
                else:
                    final_content = "任务执行完成"
            else:
                # 多智能体，整合结果
                final_content = self._synthesize_results(task, enhanced_ctx)

            execution_time = time.time() - start_time

            return AgentResponse(
                success=execution_result['success'],
                content=final_content,
                data={
                    'plan': plan.to_dict(),
                    'execution_result': execution_result
                },
                metadata={
                    'mode': plan.mode.value,
                    'total_tasks': execution_result['total_tasks'],
                    'completed_tasks': execution_result['completed_tasks'],
                    'failed_tasks': execution_result['failed_tasks']
                },
                agent_name=self.name,
                execution_time=execution_time
            )

        except Exception as e:
            logger.error(f"[MasterAgent V2] 执行失败: {e}", exc_info=True)
            return AgentResponse(
                success=False,
                error=str(e),
                agent_name=self.name,
                execution_time=time.time() - start_time
            )

    def stream_execute(
        self,
        task: str,
        context: AgentContext
    ) -> Generator[Dict[str, Any], None, None]:
        """
        流式执行任务

        Yields:
            Dict: 事件字典
        """
        try:
            # 1. 分析任务并生成执行计划
            logger.info(f"[MasterAgent V2] 流式执行 - 开始分析任务: {task}")

            yield {
                'type': 'status',
                'content': '正在分析任务...'
            }

            plan = self._analyze_and_plan(task, context)

            if not plan:
                yield {'type': 'error', 'content': '任务分析失败'}
                return

            # 2. 发送执行计划
            yield {
                'type': 'plan',
                'plan': plan.to_dict(),
                'mode': plan.mode.value,
                'subtask_count': len(plan.subtasks)
            }

            # ✨ 兼容 V1：发送 task_analysis 事件
            yield {
                'type': 'task_analysis',
                'complexity': plan.mode.value,
                'subtask_count': len(plan.subtasks),
                'reasoning': plan.reasoning
            }

            # 3. 创建增强上下文
            enhanced_ctx = EnhancedContext(session_id=context.session_id)

            # 4. 执行计划（通过生成器发送流式事件）
            logger.info(f"[MasterAgent V2] 开始执行计划，模式: {plan.mode.value}")

            # ✨ 使用生成器版本的执行计划，实时转发事件
            execution_result = None
            for event in self.dag_executor.execute_plan_stream(
                plan=plan,
                context=enhanced_ctx,
                agent_context=context
            ):
                # 实时转发事件到前端
                if event.get('type') == 'execution_result':
                    # 这是最终的执行结果，保存下来
                    execution_result = event.get('result')
                else:
                    # 其他事件立即转发
                    yield event

            # 如果没有收到执行结果，创建一个默认结果
            if execution_result is None:
                execution_result = {
                    'success': False,
                    'total_tasks': len(plan.subtasks),
                    'completed_tasks': 0,
                    'failed_tasks': 0,
                    'execution_time': 0
                }

            # 5. 整合结果（流式）
            if plan.mode != ExecutionMode.SIMPLE and len(plan.subtasks) > 1:
                yield {
                    'type': 'status',
                    'content': '正在整合结果...'
                }

                # 流式整合
                for chunk in self._synthesize_results_stream(task, enhanced_ctx):
                    yield {
                        'type': 'chunk',
                        'content': chunk.get('content', '')
                    }
                    if chunk.get('finish_reason') in ['stop', 'length']:
                        break
            else:
                # 单智能体，发送最终结果
                if plan.subtasks and plan.subtasks[0].result:
                    task_result = enhanced_ctx.get_task_result(plan.subtasks[0].id)
                    if task_result:
                        yield {
                            'type': 'chunk',
                            'content': str(task_result.content)
                        }

            # 6. 发送完成事件
            yield {
                'type': 'execution_complete',
                'success': execution_result['success'],
                'summary': {
                    'total_tasks': execution_result['total_tasks'],
                    'completed_tasks': execution_result['completed_tasks'],
                    'failed_tasks': execution_result['failed_tasks'],
                    'execution_time': execution_result['execution_time']
                }
            }

        except Exception as e:
            logger.error(f"[MasterAgent V2] 流式执行失败: {e}", exc_info=True)
            yield {
                'type': 'error',
                'content': str(e)
            }

    def _analyze_and_plan(
        self,
        task: str,
        context: AgentContext
    ) -> Optional[ExecutionPlan]:
        """
        分析任务并生成执行计划

        Args:
            task: 用户任务
            context: 上下文

        Returns:
            ExecutionPlan 或 None
        """
        try:
            # 获取可用智能体信息
            agents = self.orchestrator.list_agents()
            agents_info = "\n".join([
                f"- {agent['name']}: {agent['description']}"
                for agent in agents
                if not agent['name'].startswith('master_agent')  # 排除所有 master 类型智能体
            ])

            # 构建提示词
            prompt = self.TASK_ANALYSIS_PROMPT.format(
                agents_info=agents_info,
                task=task
            )

            # 调用 LLM 分析
            messages = [
                {"role": "system", "content": "你是一个任务规划专家，擅长分析任务复杂度和制定DAG执行计划。"},
                {"role": "user", "content": prompt}
            ]

            llm_config = self.get_llm_config()

            response = self.llm_adapter.chat_completion(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=0.0,  # 任务分析需要确定性
                max_tokens=llm_config.get('max_tokens', 2000)
            )

            if response.error:
                logger.error(f"LLM 分析失败: {response.error}")
                return None

            # 解析 JSON
            content = response.content.strip()
            if '```json' in content:
                content = content.split('```json')[1].split('```')[0].strip()
            elif '```' in content:
                content = content.split('```')[1].split('```')[0].strip()

            analysis = json.loads(content)

            # 构建执行计划
            mode_str = analysis.get('mode', 'simple')
            mode = ExecutionMode(mode_str)

            subtasks = []
            for st in analysis.get('subtasks', []):
                subtask = SubTask(
                    id=st['id'],
                    order=st['order'],
                    description=st['description'],
                    agent_name=st['agent_name'],
                    depends_on=st.get('depends_on', [])
                )
                subtasks.append(subtask)

            plan = ExecutionPlan(
                mode=mode,
                reasoning=analysis.get('reasoning', ''),
                subtasks=subtasks
            )

            logger.info(f"[MasterAgent V2] 执行计划生成成功: mode={mode.value}, subtasks={len(subtasks)}")

            return plan

        except json.JSONDecodeError as e:
            logger.error(f"解析 LLM 响应失败: {e}")
            logger.error(f"原始响应: {response.content}")
            return None
        except Exception as e:
            logger.error(f"任务分析失败: {e}", exc_info=True)
            return None

    def _synthesize_results(
        self,
        original_task: str,
        context: EnhancedContext
    ) -> str:
        """
        整合多个任务的结果（非流式）

        Args:
            original_task: 原始任务
            context: 增强上下文

        Returns:
            整合后的答案
        """
        try:
            results_summary = context.get_all_results_summary()

            prompt = self.RESULT_SYNTHESIS_PROMPT.format(
                task=original_task,
                results=results_summary
            )

            messages = [
                {"role": "system", "content": "你是一个结果整合专家。"},
                {"role": "user", "content": prompt}
            ]

            llm_config = self.get_llm_config()

            response = self.llm_adapter.chat_completion(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=0.3,
                max_tokens=llm_config.get('max_tokens', 2000)
            )

            if response.error:
                logger.error(f"结果整合失败: {response.error}")
                return results_summary  # 降级方案

            return response.content

        except Exception as e:
            logger.error(f"结果整合异常: {e}", exc_info=True)
            return context.get_all_results_summary()

    def _synthesize_results_stream(
        self,
        original_task: str,
        context: EnhancedContext
    ):
        """
        流式整合多个任务的结果

        Yields:
            Dict: {"content": "...", "finish_reason": "..."}
        """
        try:
            results_summary = context.get_all_results_summary()

            prompt = self.RESULT_SYNTHESIS_PROMPT.format(
                task=original_task,
                results=results_summary
            )

            messages = [
                {"role": "system", "content": "你是一个结果整合专家。"},
                {"role": "user", "content": prompt}
            ]

            llm_config = self.get_llm_config()

            for chunk in self.llm_adapter.chat_completion_stream(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=0.3,
                max_tokens=llm_config.get('max_tokens', 2000)
            ):
                if 'error' in chunk:
                    logger.error(f"流式整合失败: {chunk['error']}")
                    yield {"content": results_summary, "finish_reason": "stop"}
                    break

                yield chunk

                if chunk.get('finish_reason') in ['stop', 'length']:
                    break

        except Exception as e:
            logger.error(f"流式整合异常: {e}", exc_info=True)
            yield {"content": context.get_all_results_summary(), "finish_reason": "stop"}
