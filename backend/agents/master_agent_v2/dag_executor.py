# -*- coding: utf-8 -*-
"""
DAG 执行器

负责按照 DAG 依赖关系执行任务，支持并行执行
"""

import logging
import time
import asyncio
from typing import Set, List, Dict, Any, Generator, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from .execution_plan import ExecutionPlan, SubTask, TaskStatus
from .enhanced_context import EnhancedContext, TaskResult

logger = logging.getLogger(__name__)


class DAGExecutor:
    """
    DAG 执行器

    功能：
    1. 拓扑排序识别可并行任务
    2. 并行执行独立任务
    3. 失败重试机制
    4. 实时状态更新
    """

    def __init__(
        self,
        orchestrator,
        max_workers: int = 3,
        max_retries: int = 1,
        retry_delay: float = 1.0
    ):
        """
        初始化 DAG 执行器

        Args:
            orchestrator: 智能体编排器
            max_workers: 最大并行任务数
            max_retries: 最大重试次数
            retry_delay: 重试延迟（秒）
        """
        self.orchestrator = orchestrator
        self.max_workers = max_workers
        self.max_retries = max_retries
        self.retry_delay = retry_delay

    def execute_plan(
        self,
        plan: ExecutionPlan,
        context: EnhancedContext,
        agent_context,  # agents.base.AgentContext
        stream_callback=None
    ) -> Dict[str, Any]:
        """
        执行执行计划（同步版本）

        Args:
            plan: 执行计划
            context: 增强上下文
            agent_context: 智能体上下文
            stream_callback: 流式回调函数 (event: Dict) -> None

        Returns:
            执行结果字典
        """
        completed_task_ids: Set[str] = set()
        failed_task_ids: Set[str] = set()

        start_time = time.time()

        # 按照 DAG 顺序执行
        while not plan.is_completed():
            # 获取所有准备就绪的任务
            ready_tasks = plan.get_ready_tasks(completed_task_ids)

            if not ready_tasks:
                # 检查是否有死锁（所有待处理任务都依赖失败的任务）
                pending_tasks = [t for t in plan.subtasks if t.status == TaskStatus.PENDING]
                if pending_tasks:
                    logger.warning(f"[DAGExecutor] 检测到死锁，跳过 {len(pending_tasks)} 个任务")
                    for task in pending_tasks:
                        task.status = TaskStatus.SKIPPED
                        task.error = "依赖任务失败"
                        if stream_callback:
                            stream_callback({
                                'type': 'subtask_skipped',
                                'task_id': task.id,
                                'reason': '依赖任务失败'
                            })
                break

            # 标记任务为 READY
            for task in ready_tasks:
                task.status = TaskStatus.READY

            # 执行准备就绪的任务（并行）
            self._execute_parallel_tasks(
                ready_tasks,
                context,
                agent_context,
                stream_callback
            )

            # 更新完成和失败的任务集合
            for task in ready_tasks:
                if task.status == TaskStatus.COMPLETED:
                    completed_task_ids.add(task.id)
                elif task.status == TaskStatus.FAILED:
                    failed_task_ids.add(task.id)

        execution_time = time.time() - start_time

        # 收集结果
        successful_tasks = [t for t in plan.subtasks if t.status == TaskStatus.COMPLETED]
        failed_tasks = [t for t in plan.subtasks if t.status == TaskStatus.FAILED]

        return {
            'success': len(failed_tasks) == 0,
            'total_tasks': len(plan.subtasks),
            'completed_tasks': len(successful_tasks),
            'failed_tasks': len(failed_tasks),
            'skipped_tasks': len([t for t in plan.subtasks if t.status == TaskStatus.SKIPPED]),
            'execution_time': execution_time,
            'results': [t.to_dict() for t in plan.subtasks]
        }

    def execute_plan_stream(
        self,
        plan: ExecutionPlan,
        context: EnhancedContext,
        agent_context
    ) -> Generator[Dict[str, Any], None, None]:
        """
        执行执行计划（流式生成器版本）

        实时 yield 事件到前端，而不是使用回调函数

        Args:
            plan: 执行计划
            context: 增强上下文
            agent_context: 智能体上下文

        Yields:
            Dict: 事件字典
        """
        completed_task_ids: Set[str] = set()
        failed_task_ids: Set[str] = set()

        start_time = time.time()

        # 按照 DAG 顺序执行
        while not plan.is_completed():
            # 获取所有准备就绪的任务
            ready_tasks = plan.get_ready_tasks(completed_task_ids)

            if not ready_tasks:
                # 检查是否有死锁
                pending_tasks = [t for t in plan.subtasks if t.status == TaskStatus.PENDING]
                if pending_tasks:
                    logger.warning(f"[DAGExecutor] 检测到死锁，跳过 {len(pending_tasks)} 个任务")
                    for task in pending_tasks:
                        task.status = TaskStatus.SKIPPED
                        task.error = "依赖任务失败"
                        yield {
                            'type': 'subtask_skipped',
                            'task_id': task.id,
                            'reason': '依赖任务失败'
                        }
                break

            # 标记任务为 READY
            for task in ready_tasks:
                task.status = TaskStatus.READY

            # 执行准备就绪的任务（并行）- 使用生成器版本
            yield from self._execute_parallel_tasks_stream(
                ready_tasks,
                context,
                agent_context
            )

            # 更新完成和失败的任务集合
            for task in ready_tasks:
                if task.status == TaskStatus.COMPLETED:
                    completed_task_ids.add(task.id)
                elif task.status == TaskStatus.FAILED:
                    failed_task_ids.add(task.id)

        execution_time = time.time() - start_time

        # 收集结果
        successful_tasks = [t for t in plan.subtasks if t.status == TaskStatus.COMPLETED]
        failed_tasks = [t for t in plan.subtasks if t.status == TaskStatus.FAILED]

        # 发送执行结果（作为特殊事件）
        yield {
            'type': 'execution_result',
            'result': {
                'success': len(failed_tasks) == 0,
                'total_tasks': len(plan.subtasks),
                'completed_tasks': len(successful_tasks),
                'failed_tasks': len(failed_tasks),
                'skipped_tasks': len([t for t in plan.subtasks if t.status == TaskStatus.SKIPPED]),
                'execution_time': execution_time,
                'results': [t.to_dict() for t in plan.subtasks]
            }
        }

    def _execute_parallel_tasks(
        self,
        tasks: List[SubTask],
        context: EnhancedContext,
        agent_context,
        stream_callback
    ):
        """
        并行执行多个任务

        Args:
            tasks: 任务列表
            context: 增强上下文
            agent_context: 智能体上下文
            stream_callback: 流式回调
        """
        if len(tasks) == 1:
            # 单任务，直接执行
            self._execute_single_task(tasks[0], context, agent_context, stream_callback)
            return

        # 多任务，使用线程池并行执行
        with ThreadPoolExecutor(max_workers=min(len(tasks), self.max_workers)) as executor:
            future_to_task = {
                executor.submit(
                    self._execute_single_task,
                    task,
                    context,
                    agent_context,
                    stream_callback
                ): task
                for task in tasks
            }

            for future in as_completed(future_to_task):
                task = future_to_task[future]
                try:
                    future.result()
                except Exception as e:
                    logger.error(f"[DAGExecutor] 任务 {task.id} 执行异常: {e}")
                    task.status = TaskStatus.FAILED
                    task.error = str(e)

    def _execute_single_task(
        self,
        task: SubTask,
        context: EnhancedContext,
        agent_context,
        stream_callback
    ):
        """
        执行单个任务（支持重试）

        Args:
            task: 子任务
            context: 增强上下文
            agent_context: 智能体上下文
            stream_callback: 流式回调
        """
        for attempt in range(self.max_retries + 1):
            try:
                task.status = TaskStatus.RUNNING
                task.retry_count = attempt

                # 获取友好显示名称（兼容前端）
                agent = self.orchestrator.agents.get(task.agent_name)
                agent_display_name = task.agent_name
                if agent and hasattr(agent, 'agent_config') and agent.agent_config:
                    agent_display_name = agent.agent_config.display_name or task.agent_name

                if stream_callback:
                    stream_callback({
                        'type': 'subtask_start',
                        'task_id': task.id,
                        'order': task.order,
                        'agent_name': task.agent_name,
                        'agent_display_name': agent_display_name,  # ✨ 添加友好名称
                        'description': task.description,
                        'attempt': attempt + 1
                    })

                # 构建增强的任务描述（包含依赖结果）
                enhanced_description = context.build_context_for_task(
                    task.description,
                    task.depends_on
                )

                # ✨ 特殊处理：如果任务分配给 master_agent_v2 自己，直接使用 LLM 回答
                if task.agent_name in ['master_agent_v2', 'master_agent']:
                    # 直接使用 LLM 生成回答，避免递归
                    logger.info(f"[DAGExecutor] 任务 {task.id} 分配给 MasterAgent 自己，直接回答")

                    # 获取 master_agent 的 LLM adapter 和配置
                    master_agent = self.orchestrator.agents.get(task.agent_name)
                    if not master_agent or not hasattr(master_agent, 'llm_adapter'):
                        raise ValueError(f"无法获取 {task.agent_name} 的 LLM adapter")

                    # 获取 LLM 配置（注意：方法名是 get_llm_config 不是 _get_llm_config）
                    llm_config = master_agent.get_llm_config()

                    # 直接使用 LLM 生成回答
                    messages = [
                        {'role': 'user', 'content': enhanced_description}
                    ]

                    start_time = time.time()
                    llm_response = master_agent.llm_adapter.chat_completion(
                        messages=messages,
                        provider=llm_config.get('provider'),
                        model=llm_config.get('model_name'),
                        temperature=0.7,
                        max_tokens=2000
                    )

                    if llm_response.error:
                        raise Exception(f"LLM 调用失败: {llm_response.error}")

                    # 构造成功响应
                    response = type('Response', (), {
                        'success': True,
                        'content': llm_response.content,
                        'data': None,
                        'error': None
                    })()
                else:
                    # 执行任务（调用其他智能体）- 使用流式执行
                    start_time = time.time()

                    # ✨ 优先使用智能体的 execute_stream 方法以支持实时推理展示
                    if agent and hasattr(agent, 'execute_stream'):
                        logger.info(f"[DAGExecutor] 使用流式执行智能体: {task.agent_name}")

                        # 收集最终结果
                        final_content = ""
                        final_data = None

                        # 流式执行并转发事件
                        for event in agent.execute_stream(enhanced_description, agent_context):
                            # 转发事件到前端（添加 subtask_order 字段以兼容 V1）
                            if stream_callback:
                                # 为所有事件添加 subtask_order 标识
                                event_copy = event.copy()
                                event_copy['subtask_order'] = task.order
                                event_copy['task_id'] = task.id

                                # 捕获最终答案
                                if event['type'] == 'final_answer':
                                    final_content = event.get('content', '')
                                    final_data = event.get('data')

                                # 转发事件（V1 前端期望的格式）
                                stream_callback(event_copy)

                        # 构造响应对象
                        response = type('Response', (), {
                            'success': True,
                            'content': final_content,
                            'data': final_data,
                            'error': None
                        })()
                    else:
                        # 降级：使用非流式执行
                        logger.info(f"[DAGExecutor] 使用非流式执行智能体: {task.agent_name}")
                        response = self.orchestrator.execute(
                            task=enhanced_description,
                            context=agent_context,
                            preferred_agent=task.agent_name
                        )

                execution_time = time.time() - start_time

                if response.success:
                    # 任务成功
                    task.status = TaskStatus.COMPLETED
                    task.execution_time = execution_time

                    # 存储结果到增强上下文
                    task_result = TaskResult(
                        task_id=task.id,
                        description=task.description,
                        agent_name=task.agent_name,
                        success=True,
                        content=response.content,
                        data=response.data,
                        execution_time=execution_time
                    )
                    context.store_task_result(task_result)
                    task.result = task_result.to_dict()

                    if stream_callback:
                        stream_callback({
                            'type': 'subtask_end',
                            'task_id': task.id,
                            'order': task.order,
                            'success': True,
                            'result_summary': task_result.to_summary(max_length=200)
                        })

                    logger.info(f"[DAGExecutor] 任务 {task.id} 执行成功")
                    return  # 成功，退出重试循环

                else:
                    # 任务失败
                    error_msg = response.error or "未知错误"
                    logger.warning(f"[DAGExecutor] 任务 {task.id} 执行失败 (尝试 {attempt + 1}/{self.max_retries + 1}): {error_msg}")

                    if attempt < self.max_retries:
                        # 还有重试机会
                        time.sleep(self.retry_delay)
                        continue
                    else:
                        # 重试耗尽
                        task.status = TaskStatus.FAILED
                        task.error = error_msg

                        if stream_callback:
                            stream_callback({
                                'type': 'subtask_end',
                                'task_id': task.id,
                                'order': task.order,
                                'success': False,
                                'error': error_msg
                            })

                        logger.error(f"[DAGExecutor] 任务 {task.id} 最终失败")
                        return

            except Exception as e:
                error_msg = str(e)
                logger.error(f"[DAGExecutor] 任务 {task.id} 执行异常 (尝试 {attempt + 1}/{self.max_retries + 1}): {e}", exc_info=True)

                if attempt < self.max_retries:
                    time.sleep(self.retry_delay)
                    continue
                else:
                    task.status = TaskStatus.FAILED
                    task.error = error_msg

                    if stream_callback:
                        stream_callback({
                            'type': 'subtask_end',
                            'task_id': task.id,
                            'order': task.order,
                            'success': False,
                            'error': error_msg
                        })

                    return

    def _execute_parallel_tasks_stream(
        self,
        tasks: List[SubTask],
        context: EnhancedContext,
        agent_context
    ) -> Generator[Dict[str, Any], None, None]:
        """
        并行执行多个任务（流式生成器版本）

        Args:
            tasks: 任务列表
            context: 增强上下文
            agent_context: 智能体上下文

        Yields:
            Dict: 事件字典
        """
        if len(tasks) == 1:
            # 单任务，直接执行
            yield from self._execute_single_task_stream(tasks[0], context, agent_context)
            return

        # 多任务并行执行 - 这里需要特殊处理
        # 因为生成器不能直接在多线程中使用
        # 我们使用队列来收集事件，然后 yield

        import queue
        import threading

        event_queue = queue.Queue()
        exceptions = []

        def task_wrapper(task):
            """在线程中执行任务并将事件放入队列"""
            try:
                for event in self._execute_single_task_stream(task, context, agent_context):
                    event_queue.put(event)
            except Exception as e:
                logger.error(f"[DAGExecutor] 任务 {task.id} 线程异常: {e}")
                exceptions.append((task, e))
                task.status = TaskStatus.FAILED
                task.error = str(e)
            finally:
                # 发送任务完成标记
                event_queue.put({'_task_done': task.id})

        # 启动所有任务线程
        threads = []
        for task in tasks:
            thread = threading.Thread(target=task_wrapper, args=(task,))
            thread.start()
            threads.append(thread)

        # 从队列中读取事件并 yield
        completed_count = 0
        while completed_count < len(tasks):
            try:
                event = event_queue.get(timeout=0.1)
                if '_task_done' in event:
                    completed_count += 1
                else:
                    yield event
            except queue.Empty:
                # 检查是否所有线程都已结束
                if all(not t.is_alive() for t in threads):
                    break
                continue

        # 等待所有线程结束
        for thread in threads:
            thread.join(timeout=1.0)

    def _execute_single_task_stream(
        self,
        task: SubTask,
        context: EnhancedContext,
        agent_context
    ) -> Generator[Dict[str, Any], None, None]:
        """
        执行单个任务（流式生成器版本，支持重试）

        Args:
            task: 子任务
            context: 增强上下文
            agent_context: 智能体上下文

        Yields:
            Dict: 事件字典
        """
        for attempt in range(self.max_retries + 1):
            try:
                task.status = TaskStatus.RUNNING
                task.retry_count = attempt

                # 获取友好显示名称
                agent = self.orchestrator.agents.get(task.agent_name)
                agent_display_name = task.agent_name
                if agent and hasattr(agent, 'agent_config') and agent.agent_config:
                    agent_display_name = agent.agent_config.display_name or task.agent_name

                # 发送开始事件
                yield {
                    'type': 'subtask_start',
                    'task_id': task.id,
                    'order': task.order,
                    'agent_name': task.agent_name,
                    'agent_display_name': agent_display_name,
                    'description': task.description,
                    'attempt': attempt + 1
                }

                # 构建增强的任务描述
                enhanced_description = context.build_context_for_task(
                    task.description,
                    task.depends_on
                )

                # 特殊处理：master_agent 自己回答
                if task.agent_name in ['master_agent_v2', 'master_agent']:
                    logger.info(f"[DAGExecutor] 任务 {task.id} 分配给 MasterAgent 自己，直接回答")

                    master_agent = self.orchestrator.agents.get(task.agent_name)
                    if not master_agent or not hasattr(master_agent, 'llm_adapter'):
                        raise ValueError(f"无法获取 {task.agent_name} 的 LLM adapter")

                    llm_config = master_agent.get_llm_config()
                    messages = [{'role': 'user', 'content': enhanced_description}]

                    start_time = time.time()
                    llm_response = master_agent.llm_adapter.chat_completion(
                        messages=messages,
                        provider=llm_config.get('provider'),
                        model=llm_config.get('model_name'),
                        temperature=0.7,
                        max_tokens=2000
                    )

                    if llm_response.error:
                        raise Exception(f"LLM 调用失败: {llm_response.error}")

                    final_content = llm_response.content
                    final_data = None

                else:
                    # 执行任务（调用其他智能体）- 使用流式执行
                    start_time = time.time()

                    if agent and hasattr(agent, 'execute_stream'):
                        logger.info(f"[DAGExecutor] 使用流式执行智能体: {task.agent_name}")

                        final_content = ""
                        final_data = None

                        # 流式执行并转发事件
                        for event in agent.execute_stream(enhanced_description, agent_context):
                            # 为事件添加任务标识
                            event_copy = event.copy()
                            event_copy['subtask_order'] = task.order
                            event_copy['task_id'] = task.id

                            # 捕获最终答案
                            if event['type'] == 'final_answer':
                                final_content = event.get('content', '')
                                final_data = event.get('data')

                            # 转发事件
                            yield event_copy

                    else:
                        # 降级：非流式执行
                        logger.info(f"[DAGExecutor] 使用非流式执行智能体: {task.agent_name}")
                        response = self.orchestrator.execute(
                            task=enhanced_description,
                            context=agent_context,
                            preferred_agent=task.agent_name
                        )

                        if not response.success:
                            raise Exception(response.error or "任务执行失败")

                        final_content = response.content
                        final_data = response.data

                execution_time = time.time() - start_time

                # 任务成功
                task.status = TaskStatus.COMPLETED
                task.execution_time = execution_time

                # 存储结果
                task_result = TaskResult(
                    task_id=task.id,
                    description=task.description,
                    agent_name=task.agent_name,
                    success=True,
                    content=final_content,
                    data=final_data,
                    execution_time=execution_time
                )
                context.store_task_result(task_result)
                task.result = task_result.to_dict()

                # 发送完成事件
                yield {
                    'type': 'subtask_end',
                    'task_id': task.id,
                    'order': task.order,
                    'success': True,
                    'result_summary': task_result.to_summary(max_length=200)
                }

                logger.info(f"[DAGExecutor] 任务 {task.id} 执行成功")
                return  # 成功，退出重试循环

            except Exception as e:
                error_msg = str(e)
                logger.error(f"[DAGExecutor] 任务 {task.id} 执行异常 (尝试 {attempt + 1}/{self.max_retries + 1}): {e}", exc_info=True)

                if attempt < self.max_retries:
                    time.sleep(self.retry_delay)
                    continue
                else:
                    task.status = TaskStatus.FAILED
                    task.error = error_msg

                    yield {
                        'type': 'subtask_end',
                        'task_id': task.id,
                        'order': task.order,
                        'success': False,
                        'error': error_msg
                    }

                    return

