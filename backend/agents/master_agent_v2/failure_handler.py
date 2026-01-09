# -*- coding: utf-8 -*-
"""
任务失败处理器 - MasterAgent V2

支持多种失败恢复策略:
1. 重试 (retry)
2. 跳过 (skip)
3. 使用缓存 (use_cache)
4. 询问 LLM 替代方案 (ask_llm)
5. 中止流程 (abort)
"""

import logging
import time
import json
from typing import Optional, Dict, Any
from ..base import AgentResponse
from .execution_plan import TaskNode, FallbackStrategy
from .enhanced_context import EnhancedAgentContext

logger = logging.getLogger(__name__)


class FailureHandler:
    """任务失败处理器"""

    def __init__(self, orchestrator, master_agent):
        """
        初始化失败处理器

        Args:
            orchestrator: 智能体编排器
            master_agent: MasterAgent 实例
        """
        self.orchestrator = orchestrator
        self.master_agent = master_agent
        self.llm_adapter = master_agent.llm_adapter

    def handle_failure(
        self,
        task_node: TaskNode,
        context: EnhancedAgentContext,
        error: Exception
    ) -> Optional[AgentResponse]:
        """
        处理任务失败

        Args:
            task_node: 失败的任务节点
            context: 上下文
            error: 错误信息

        Returns:
            AgentResponse 或 None (如果无法恢复)
        """
        strategy = task_node.fallback_strategy

        logger.warning(
            f"任务 {task_node.id} 执行失败: {error}, "
            f"使用策略: {strategy.value}"
        )

        # 记录失败
        context.stats['failed_tasks'].append({
            'task_id': task_node.id,
            'error': str(error),
            'strategy': strategy.value,
            'timestamp': time.time()
        })

        try:
            if strategy == FallbackStrategy.RETRY:
                return self._retry_task(task_node, context, error)

            elif strategy == FallbackStrategy.SKIP:
                return self._skip_task(task_node, context, error)

            elif strategy == FallbackStrategy.USE_CACHE:
                return self._use_cached_result(task_node, context, error)

            elif strategy == FallbackStrategy.ASK_LLM:
                return self._ask_llm_for_alternative(task_node, context, error)

            elif strategy == FallbackStrategy.ABORT:
                raise error  # 重新抛出，中止流程

            else:
                # 默认: 优雅降级（跳过）
                return self._graceful_degrade(task_node, context, error)

        except Exception as e:
            logger.error(f"失败处理器执行失败: {e}", exc_info=True)
            return None

    def _retry_task(
        self,
        task_node: TaskNode,
        context: EnhancedAgentContext,
        original_error: Exception,
        max_retries: int = 3
    ) -> Optional[AgentResponse]:
        """
        重试任务

        Args:
            task_node: 任务节点
            context: 上下文
            original_error: 原始错误
            max_retries: 最大重试次数

        Returns:
            AgentResponse 或 None
        """
        logger.info(f"开始重试任务 {task_node.id}, 最大重试次数: {max_retries}")

        for attempt in range(max_retries):
            try:
                # 指数退避
                if attempt > 0:
                    wait_time = 2 ** attempt
                    logger.info(f"重试前等待 {wait_time} 秒...")
                    time.sleep(wait_time)

                logger.info(f"第 {attempt + 1} 次重试任务 {task_node.id}")

                # 重新执行任务
                response = self.orchestrator.execute(
                    task=task_node.description,
                    context=context,
                    preferred_agent=task_node.agent
                )

                if response.success:
                    logger.info(f"任务 {task_node.id} 重试成功")
                    response.metadata['retry_count'] = attempt + 1
                    return response

            except Exception as e:
                logger.warning(f"第 {attempt + 1} 次重试失败: {e}")
                if attempt == max_retries - 1:
                    logger.error(f"任务 {task_node.id} 达到最大重试次数，失败")
                    return None

        return None

    def _skip_task(
        self,
        task_node: TaskNode,
        context: EnhancedAgentContext,
        error: Exception
    ) -> AgentResponse:
        """
        跳过任务（标记为可选）

        Args:
            task_node: 任务节点
            context: 上下文
            error: 错误信息

        Returns:
            AgentResponse（success=False, skipped=True）
        """
        logger.info(f"跳过任务 {task_node.id} (可选任务)")

        # 记录跳过
        context.stats['skipped_tasks'].append(task_node.id)

        return AgentResponse(
            success=False,
            content=f"任务被跳过: {str(error)}",
            agent_name=task_node.agent,
            metadata={
                'skipped': True,
                'optional': task_node.optional,
                'error': str(error)
            }
        )

    def _use_cached_result(
        self,
        task_node: TaskNode,
        context: EnhancedAgentContext,
        error: Exception
    ) -> Optional[AgentResponse]:
        """
        使用缓存结果

        Args:
            task_node: 任务节点
            context: 上下文
            error: 错误信息

        Returns:
            AgentResponse 或 None
        """
        logger.info(f"尝试为任务 {task_node.id} 使用缓存结果")

        # 从上下文查找缓存
        cache_key = f"cache_{task_node.agent}_{hash(task_node.description)}"

        if cache_key in context.intermediate_results:
            cached_data = context.intermediate_results[cache_key]
            logger.info(f"找到缓存结果: {cache_key}")

            return AgentResponse(
                success=True,
                content=cached_data.get('content', ''),
                data=cached_data.get('data'),
                agent_name=task_node.agent,
                metadata={
                    'from_cache': True,
                    'cache_key': cache_key
                }
            )

        logger.warning(f"未找到缓存结果: {cache_key}")
        # 降级到跳过
        return self._skip_task(task_node, context, error)

    def _ask_llm_for_alternative(
        self,
        task_node: TaskNode,
        context: EnhancedAgentContext,
        error: Exception
    ) -> Optional[AgentResponse]:
        """
        询问 LLM 是否有替代方案

        Args:
            task_node: 任务节点
            context: 上下文
            error: 错误信息

        Returns:
            AgentResponse 或 None
        """
        logger.info(f"询问 LLM 为任务 {task_node.id} 提供替代方案")

        try:
            # 获取可用智能体列表
            available_agents = [
                a['name'] for a in self.orchestrator.list_agents()
                if a['name'] != task_node.agent and a['name'] != 'master_agent'
            ]

            prompt = f"""
任务执行失败，需要你分析并提供替代方案。

**失败任务**:
- 任务ID: {task_node.id}
- 描述: {task_node.description}
- 原定智能体: {task_node.agent}
- 错误信息: {str(error)}

**可用的其他智能体**:
{json.dumps(available_agents, ensure_ascii=False)}

**请分析**:
1. 失败原因是什么?
2. 是否可以用其他智能体完成?
3. 是否可以简化任务?
4. 是否可以基于已有数据回答?

**输出 JSON 格式**:
{{
  "has_alternative": true/false,
  "alternative_agent": "agent_name" or null,
  "simplified_task": "简化后的任务描述" or null,
  "use_existing_data": true/false,
  "reasoning": "你的分析"
}}

只返回 JSON。
"""

            llm_config = self.master_agent.get_llm_config()
            response = self.llm_adapter.chat_completion(
                messages=[
                    {"role": "system", "content": "你是任务恢复专家"},
                    {"role": "user", "content": prompt}
                ],
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

            alternative = json.loads(content)

            logger.info(f"LLM 替代方案: {alternative['reasoning']}")

            if not alternative.get('has_alternative'):
                logger.info("LLM 判断无替代方案，跳过任务")
                return self._skip_task(task_node, context, error)

            # 尝试替代方案
            if alternative.get('use_existing_data'):
                # 基于已有数据生成回答
                dep_data = context.get_dependency_data(task_node.depends_on)
                fallback_answer = f"基于已有数据: {json.dumps(dep_data, ensure_ascii=False)[:200]}"

                return AgentResponse(
                    success=True,
                    content=fallback_answer,
                    agent_name=task_node.agent,
                    metadata={
                        'alternative': True,
                        'strategy': 'use_existing_data'
                    }
                )

            elif alternative.get('alternative_agent'):
                # 使用其他智能体
                alt_agent = alternative['alternative_agent']
                alt_task = alternative.get('simplified_task') or task_node.description

                logger.info(f"使用替代智能体 {alt_agent} 执行任务")

                response = self.orchestrator.execute(
                    task=alt_task,
                    context=context,
                    preferred_agent=alt_agent
                )

                if response.success:
                    response.metadata['alternative'] = True
                    response.metadata['original_agent'] = task_node.agent
                    response.metadata['alternative_agent'] = alt_agent

                return response

            else:
                # 无可行方案
                return self._skip_task(task_node, context, error)

        except Exception as e:
            logger.error(f"询问 LLM 替代方案失败: {e}", exc_info=True)
            return self._skip_task(task_node, context, error)

    def _graceful_degrade(
        self,
        task_node: TaskNode,
        context: EnhancedAgentContext,
        error: Exception
    ) -> AgentResponse:
        """
        优雅降级（默认策略）

        Args:
            task_node: 任务节点
            context: 上下文
            error: 错误信息

        Returns:
            AgentResponse（标记失败但不中止流程）
        """
        logger.info(f"任务 {task_node.id} 优雅降级")

        return AgentResponse(
            success=False,
            content=f"任务执行失败，已优雅降级: {str(error)}",
            error=str(error),
            agent_name=task_node.agent,
            metadata={
                'degraded': True,
                'optional': task_node.optional
            }
        )

    def should_continue_after_failure(
        self,
        task_node: TaskNode,
        dependent_tasks: list,
        context: EnhancedAgentContext
    ) -> bool:
        """
        判断任务失败后是否应该继续执行

        Args:
            task_node: 失败的任务节点
            dependent_tasks: 依赖该任务的其他任务
            context: 上下文

        Returns:
            是否继续执行
        """
        # 如果是可选任务，继续执行
        if task_node.optional:
            return True

        # 如果没有依赖任务，继续执行其他独立任务
        if not dependent_tasks:
            return True

        # 如果失败策略是 ABORT，停止执行
        if task_node.fallback_strategy == FallbackStrategy.ABORT:
            return False

        # 默认：继续执行不依赖该任务的其他任务
        return True
