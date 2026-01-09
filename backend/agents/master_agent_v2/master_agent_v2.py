# -*- coding: utf-8 -*-
"""
MasterAgentV2 - 增强的主协调智能体

新增功能：
1. 三种执行模式：直接回答、静态 DAG、混合模式
2. 智能任务分析（自动选择执行模式）
3. 增强的上下文管理（结果缓存、依赖传递）
4. 失败恢复机制（重试、跳过、降级）
5. 流式执行支持
6. 执行统计和监控

相比 V1 的改进：
- V1: 简单的任务分解 + 顺序执行
- V2: 智能模式选择 + DAG 调度 + 动态执行 + 失败恢复
"""

import asyncio
import logging
import json
import time
from typing import Dict, Any, Optional, List, AsyncGenerator, Generator
from ..base import BaseAgent, AgentContext, AgentResponse
from .enhanced_context import EnhancedAgentContext
from .execution_plan import (
    ExecutionPlan,
    ExecutionMode,
    create_execution_plan
)
from .hybrid_scheduler import HybridScheduler

logger = logging.getLogger(__name__)


class MasterAgentV2(BaseAgent):
    """
    MasterAgent V2 - 增强的主协调智能体

    核心能力：
    1. 智能任务分析 - 自动判断最优执行模式
    2. 三种执行模式:
       - DirectAnswer: 简单对话，直接回答
       - StaticPlan: 复杂任务，预定义 DAG
       - HybridPlan: 超复杂任务，宏观静态 + 微观动态
    3. 增强的上下文 - 结果缓存、依赖管理、摘要
    4. 失败恢复 - 多种策略（重试、跳过、降级）
    5. 流式执行 - 实时反馈执行进度
    """

    # 任务分析提示词（V2 版本，支持三种模式）
    TASK_ANALYSIS_PROMPT_V2 = """你是一个高级任务规划专家。分析用户任务并选择最优执行模式。

**可用智能体**:
{agents_info}

**用户任务**:
"{task}"

**执行模式说明**:
1. **direct_answer**: 简单对话、闲聊、无需调用工具
   - 示例: "你好", "今天天气怎么样", "介绍一下自己"

2. **static_plan**: 复杂任务，需要多步骤，可预先规划 DAG
   - 示例: "查询数据 → 分析 → 生成报告"
   - 任务依赖明确，可以并行执行

3. **hybrid_plan**: 超复杂任务，部分可规划，部分需动态决策
   - 示例: "先查询数据（静态），再根据结果动态探索（动态）"
   - 适合不确定性高、需要反馈循环的任务

**请输出 JSON**:

**模式 1: direct_answer**
{{
  "mode": "direct_answer",
  "reasoning": "分析理由",
  "answer": "直接回答内容"
}}

**模式 2: static_plan**
{{
  "mode": "static_plan",
  "reasoning": "分析理由",
  "execution_strategy": "sequential|parallel",
  "subtasks": [
    {{
      "id": "task_1",
      "description": "任务描述",
      "agent": "agent_name",
      "depends_on": [],
      "estimated_complexity": 3,
      "optional": false,
      "fallback_strategy": "retry|skip|use_cache|ask_llm|abort"
    }}
  ]
}}

**模式 3: hybrid_plan**
{{
  "mode": "hybrid_plan",
  "reasoning": "分析理由",
  "stages": [
    {{
      "stage_id": "stage_1",
      "name": "阶段名称",
      "type": "static|dynamic",
      "description": "阶段描述",
      "depends_on": [],

      // type=static 时:
      "subtasks": [...],  // 同 static_plan

      // type=dynamic 时:
      "max_rounds": 5,
      "available_agents": ["agent1", "agent2"],
      "goal": "动态阶段的目标"
    }}
  ]
}}

**选择建议**:
- 95% 的任务应该是 direct_answer 或 static_plan
- 只有非常复杂、不确定性高的任务才用 hybrid_plan
- 如果不确定，优先选择更简单的模式

**fallback_strategy 说明**:
- retry: 重试（默认）
- skip: 跳过（适合可选任务）
- use_cache: 使用缓存
- ask_llm: 询问 LLM 替代方案
- abort: 中止整个流程

只返回 JSON，不要有其他内容。
"""

    def __init__(
        self,
        llm_adapter,
        orchestrator,
        agent_config=None,
        system_config=None
    ):
        """
        初始化 MasterAgentV2

        Args:
            llm_adapter: LLM 适配器
            orchestrator: 智能体编排器
            agent_config: 智能体配置
            system_config: 系统配置
        """
        super().__init__(
            name='master_agent_v2',
            description='MasterAgent V2 - 增强的主协调智能体，支持 DAG 和混合模式执行',
            capabilities=[
                'task_analysis_v2',
                'dag_execution',
                'hybrid_execution',
                'failure_recovery',
                'stream_execution',
                'context_management'
            ],
            llm_adapter=llm_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.orchestrator = orchestrator
        self.scheduler = HybridScheduler(orchestrator, self)

        self.logger.info("MasterAgentV2 初始化完成")

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        """
        判断是否能处理该任务

        V2 作为统一入口，处理所有任务
        """
        return True

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        """
        同步执行任务（阻塞版本）

        注意：V2 主要设计为异步流式执行，此方法为兼容性保留

        Args:
            task: 用户任务
            context: 上下文

        Returns:
            AgentResponse
        """
        start_time = time.time()

        try:
            # 升级为增强上下文
            enhanced_context = self._ensure_enhanced_context(context)

            # 1. 分析任务
            self.logger.info(f"[MasterAgentV2] 分析任务: {task}")
            analysis = self._analyze_task_v2(task, enhanced_context)

            if not analysis:
                return AgentResponse(
                    success=False,
                    error="任务分析失败",
                    agent_name=self.name
                )

            # 2. 创建执行计划
            try:
                plan = create_execution_plan(analysis)
            except ValueError as e:
                return AgentResponse(
                    success=False,
                    error=f"创建执行计划失败: {e}",
                    agent_name=self.name
                )

            self.logger.info(f"[MasterAgentV2] 执行模式: {plan.mode.value}")

            # 3. 执行计划（使用 asyncio 运行异步代码）
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            try:
                result = loop.run_until_complete(
                    self._execute_plan_sync(plan, enhanced_context)
                )
            finally:
                loop.close()

            execution_time = time.time() - start_time

            return AgentResponse(
                success=True,
                content=result['content'],
                data={
                    'plan_summary': plan.get_summary(),
                    'stats': enhanced_context.get_summary(),
                    'execution_details': result.get('details')
                },
                agent_name=self.name,
                execution_time=execution_time
            )

        except Exception as e:
            self.logger.error(f"[MasterAgentV2] 执行失败: {e}", exc_info=True)
            return AgentResponse(
                success=False,
                error=f"执行失败: {str(e)}",
                agent_name=self.name,
                execution_time=time.time() - start_time
            )

    async def execute_stream(
        self,
        task: str,
        context: AgentContext
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        异步流式执行任务（推荐使用）

        Args:
            task: 用户任务
            context: 上下文

        Yields:
            执行事件流
        """
        start_time = time.time()

        try:
            # 升级为增强上下文
            enhanced_context = self._ensure_enhanced_context(context)

            # 1. 分析任务
            self.logger.info(f"[MasterAgentV2] 分析任务: {task}")

            yield {
                "type": "task_analysis_start",
                "message": "正在分析任务..."
            }

            analysis = self._analyze_task_v2(task, enhanced_context)

            if not analysis:
                yield {
                    "type": "error",
                    "content": "任务分析失败"
                }
                return

            # 发送分析结果
            yield {
                "type": "task_analysis_complete",
                "mode": analysis.get('mode'),
                "reasoning": analysis.get('reasoning', '')
            }

            # 2. 创建执行计划
            try:
                plan = create_execution_plan(analysis)
            except ValueError as e:
                yield {
                    "type": "error",
                    "content": f"创建执行计划失败: {e}"
                }
                return

            self.logger.info(
                f"[MasterAgentV2] 执行模式: {plan.mode.value}, "
                f"计划摘要: {plan.get_summary()}"
            )

            # 发送计划摘要
            yield {
                "type": "execution_plan",
                "plan_summary": plan.get_summary()
            }

            # 3. 执行计划（流式）
            async for event in self.scheduler.execute_plan(plan, enhanced_context):
                yield event

            # 4. 发送执行统计
            execution_time = time.time() - start_time
            stats = enhanced_context.get_summary()
            stats['execution_time'] = execution_time

            yield {
                "type": "execution_complete",
                "stats": stats
            }

        except Exception as e:
            self.logger.error(f"[MasterAgentV2] 流式执行失败: {e}", exc_info=True)
            yield {
                "type": "error",
                "content": str(e)
            }

    def stream_execute(
        self,
        task: str,
        context: AgentContext
    ) -> Generator[Dict[str, Any], None, None]:
        """
        同步流式执行任务（兼容 V1 接口）

        这是 execute_stream 的同步包装器，用于兼容现有的同步代码（如 routes）

        Args:
            task: 用户任务
            context: 上下文

        Yields:
            执行事件流
        """
        # 使用 asyncio.run 执行异步生成器
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        try:
            async_gen = self.execute_stream(task, context)

            # 手动迭代异步生成器
            while True:
                try:
                    event = loop.run_until_complete(async_gen.__anext__())
                    yield event
                except StopAsyncIteration:
                    break
        finally:
            loop.close()

    def _ensure_enhanced_context(
        self,
        context: AgentContext
    ) -> EnhancedAgentContext:
        """
        确保上下文是 EnhancedAgentContext

        Args:
            context: 原始上下文

        Returns:
            EnhancedAgentContext
        """
        if isinstance(context, EnhancedAgentContext):
            return context

        # 升级为增强上下文
        return EnhancedAgentContext.from_base(context, self.llm_adapter)

    def _analyze_task_v2(
        self,
        task: str,
        context: EnhancedAgentContext
    ) -> Optional[Dict[str, Any]]:
        """
        分析任务（V2 版本，支持三种模式）

        Args:
            task: 用户任务
            context: 增强上下文

        Returns:
            分析结果字典
        """
        try:
            # 获取可用智能体信息
            agents = self.orchestrator.list_agents()
            agents_info = "\n".join([
                f"- {agent['name']}: {agent['description']}"
                for agent in agents
                if agent['name'] not in ['master_agent', 'master_agent_v2']
            ])

            # 构建提示词
            prompt = self.TASK_ANALYSIS_PROMPT_V2.format(
                agents_info=agents_info,
                task=task
            )

            # 调用 LLM 分析
            messages = [
                {
                    "role": "system",
                    "content": "你是一个高级任务规划专家，擅长分析任务复杂度并选择最优执行策略。"
                },
                {"role": "user", "content": prompt}
            ]

            llm_config = self.get_llm_config()
            analysis_temperature = self.get_custom_param('analysis_temperature', default=0.0)

            response = self.llm_adapter.chat_completion(
                messages=messages,
                provider=llm_config.get('provider'),
                model=llm_config.get('model_name'),
                temperature=analysis_temperature,
                max_tokens=llm_config.get('max_tokens', 2000),
                timeout=llm_config.get('timeout'),
                max_retries=llm_config.get('retry_attempts'),
                response_format={"type": "json_object"}
            )

            # 记录 LLM 调用
            context.increment_llm_calls()

            if response.error:
                self.logger.error(f"LLM 分析失败: {response.error}")
                return None

            # 解析 JSON
            content = response.content.strip()
            if '```json' in content:
                content = content.split('```json')[1].split('```')[0].strip()
            elif '```' in content:
                content = content.split('```')[1].split('```')[0].strip()

            analysis = json.loads(content)

            self.logger.info(
                f"[MasterAgentV2] 任务分析完成: 模式={analysis.get('mode')}, "
                f"理由={analysis.get('reasoning', '')[:100]}"
            )

            return analysis

        except json.JSONDecodeError as e:
            self.logger.error(f"解析 LLM 响应失败: {e}")
            self.logger.error(f"原始响应: {response.content}")
            return None
        except Exception as e:
            self.logger.error(f"任务分析失败: {e}", exc_info=True)
            return None

    async def _execute_plan_sync(
        self,
        plan: ExecutionPlan,
        context: EnhancedAgentContext
    ) -> Dict[str, Any]:
        """
        同步执行计划（收集所有流式事件）

        Args:
            plan: 执行计划
            context: 增强上下文

        Returns:
            执行结果字典
        """
        content_chunks = []
        details = []

        async for event in self.scheduler.execute_plan(plan, context):
            event_type = event.get('type')

            # 收集内容块
            if event_type == 'chunk':
                content_chunks.append(event.get('content', ''))

            # 收集详细信息
            details.append(event)

        # 拼接内容
        full_content = ''.join(content_chunks)

        return {
            'content': full_content,
            'details': details
        }

    def get_info(self) -> Dict[str, Any]:
        """
        获取智能体信息

        Returns:
            智能体信息字典
        """
        base_info = super().get_info()

        base_info.update({
            'version': 'v2',
            'execution_modes': [
                'direct_answer',
                'static_plan',
                'hybrid_plan'
            ],
            'features': [
                'DAG 调度',
                '混合模式执行',
                '失败恢复',
                '流式执行',
                '增强上下文管理'
            ]
        })

        return base_info


# 便捷函数：从 V1 迁移到 V2
def upgrade_to_v2(master_agent_v1, orchestrator) -> MasterAgentV2:
    """
    从 MasterAgent V1 升级到 V2

    Args:
        master_agent_v1: V1 实例
        orchestrator: 编排器

    Returns:
        MasterAgentV2 实例
    """
    return MasterAgentV2(
        llm_adapter=master_agent_v1.llm_adapter,
        orchestrator=orchestrator,
        agent_config=master_agent_v1.agent_config,
        system_config=master_agent_v1.system_config
    )
