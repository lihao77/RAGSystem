# -*- coding: utf-8 -*-
"""
增强的智能体上下文 - 支持 MasterAgent V2

新增功能:
1. 任务结果存储和智能摘要
2. 阶段输出管理
3. 依赖数据传递优化
4. 执行统计
"""

import json
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime
from dataclasses import dataclass, field
from ..base import AgentContext

logger = logging.getLogger(__name__)


@dataclass
class TaskResult:
    """任务执行结果"""
    task_id: str
    data: Any
    timestamp: datetime
    success: bool = True
    error: Optional[str] = None
    token_size: int = 0  # 估算的 token 大小


@dataclass
class StageOutput:
    """阶段输出"""
    stage_id: str
    stage_name: str
    output: Any
    timestamp: datetime
    tasks_completed: List[str] = field(default_factory=list)
    success: bool = True


class EnhancedAgentContext(AgentContext):
    """
    增强的智能体上下文

    在 AgentContext 基础上增加:
    - 任务结果管理
    - 阶段输出管理
    - 智能数据摘要
    - 执行统计
    """

    def __init__(
        self,
        session_id: str,
        user_id: Optional[str] = None,
        initial_data: Optional[Dict[str, Any]] = None,
        llm_adapter=None  # 用于生成摘要
    ):
        super().__init__(session_id, user_id, initial_data)

        # LLM 适配器（用于智能摘要）
        self.llm_adapter = llm_adapter

        # 任务结果存储
        self.task_results: Dict[str, TaskResult] = {}

        # 阶段输出存储
        self.stage_outputs: Dict[str, StageOutput] = {}

        # 数据摘要缓存
        self.summary_cache: Dict[str, str] = {}

        # 执行统计
        self.stats = {
            'total_llm_calls': 0,
            'total_tool_calls': 0,
            'total_tokens': 0,
            'execution_path': [],  # 记录实际执行路径
            'failed_tasks': [],
            'skipped_tasks': []
        }

    @classmethod
    def from_base(cls, base_context: AgentContext, llm_adapter=None):
        """
        从基础 AgentContext 升级为 EnhancedAgentContext

        Args:
            base_context: 基础上下文
            llm_adapter: LLM 适配器

        Returns:
            EnhancedAgentContext
        """
        enhanced = cls(
            session_id=base_context.session_id,
            user_id=base_context.user_id,
            initial_data=base_context.shared_data,
            llm_adapter=llm_adapter
        )

        # 复制历史消息
        enhanced.conversation_history = base_context.conversation_history.copy()
        enhanced.intermediate_results = base_context.intermediate_results.copy()
        enhanced.metadata = base_context.metadata.copy()
        enhanced.agent_stack = base_context.agent_stack.copy()

        return enhanced

    def store_task_result(
        self,
        task_id: str,
        data: Any,
        success: bool = True,
        error: Optional[str] = None,
        auto_summarize: bool = True
    ):
        """
        存储任务结果，自动判断是否需要摘要

        Args:
            task_id: 任务ID
            data: 结果数据
            success: 是否成功
            error: 错误信息（如果失败）
            auto_summarize: 是否自动摘要
        """
        # 估算 token 大小
        token_size = self._estimate_token_size(data)

        # 存储原始结果
        task_result = TaskResult(
            task_id=task_id,
            data=data,
            timestamp=datetime.now(),
            success=success,
            error=error,
            token_size=token_size
        )
        self.task_results[task_id] = task_result

        # 记录统计
        if not success:
            self.stats['failed_tasks'].append(task_id)

        # 智能摘要
        if auto_summarize and success and token_size > 500:
            summary = self._auto_summarize(data)
            self.summary_cache[task_id] = summary
            logger.info(f"任务 {task_id} 结果已自动摘要 (原始: {token_size} tokens)")

    def store_stage_output(
        self,
        stage_id: str,
        stage_name: str,
        output: Any,
        tasks_completed: List[str],
        success: bool = True
    ):
        """
        存储阶段输出

        Args:
            stage_id: 阶段ID
            stage_name: 阶段名称
            output: 阶段输出
            tasks_completed: 完成的任务列表
            success: 是否成功
        """
        stage_output = StageOutput(
            stage_id=stage_id,
            stage_name=stage_name,
            output=output,
            timestamp=datetime.now(),
            tasks_completed=tasks_completed,
            success=success
        )
        self.stage_outputs[stage_id] = stage_output

        logger.info(
            f"阶段 {stage_id} ({stage_name}) 输出已存储, "
            f"完成任务: {len(tasks_completed)}"
        )

    def get_dependency_data(
        self,
        depends_on: List[str],
        use_summary: Optional[bool] = None,
        max_tokens: int = 2000
    ) -> Dict[str, Any]:
        """
        获取依赖任务的数据

        Args:
            depends_on: 依赖任务ID列表
            use_summary: 是否使用摘要 (None=自动判断)
            max_tokens: 最大 token 数阈值

        Returns:
            {task_id: data_or_summary}
        """
        result = {}
        total_size = 0

        for task_id in depends_on:
            if task_id not in self.task_results:
                logger.warning(f"依赖任务 {task_id} 结果不存在")
                continue

            task_result = self.task_results[task_id]

            # 如果任务失败，跳过
            if not task_result.success:
                logger.warning(f"依赖任务 {task_id} 执行失败，跳过")
                continue

            data_size = task_result.token_size
            total_size += data_size

            # 自动判断是否使用摘要
            if use_summary is None:
                use_summary = (total_size > max_tokens)

            if use_summary and task_id in self.summary_cache:
                result[task_id] = {
                    'summary': self.summary_cache[task_id],
                    'original_size': data_size,
                    'is_summary': True
                }
            else:
                result[task_id] = {
                    'data': task_result.data,
                    'is_summary': False
                }

        logger.info(
            f"获取依赖数据: {len(depends_on)} 个任务, "
            f"总大小: {total_size} tokens, "
            f"使用摘要: {use_summary}"
        )

        return result

    def get_stage_dependency_data(
        self,
        depends_on: List[str]
    ) -> Dict[str, Any]:
        """
        获取依赖阶段的输出

        Args:
            depends_on: 依赖阶段ID列表

        Returns:
            {stage_id: output}
        """
        result = {}

        for stage_id in depends_on:
            if stage_id not in self.stage_outputs:
                logger.warning(f"依赖阶段 {stage_id} 输出不存在")
                continue

            stage_output = self.stage_outputs[stage_id]

            if stage_output.success:
                result[stage_id] = stage_output.output
            else:
                logger.warning(f"依赖阶段 {stage_id} 执行失败")

        return result

    def record_execution_step(self, step_info: Dict[str, Any]):
        """
        记录执行步骤

        Args:
            step_info: 步骤信息
        """
        self.stats['execution_path'].append({
            'timestamp': datetime.now().isoformat(),
            **step_info
        })

    def increment_llm_calls(self, tokens: int = 0):
        """增加 LLM 调用计数"""
        self.stats['total_llm_calls'] += 1
        self.stats['total_tokens'] += tokens

    def increment_tool_calls(self):
        """增加工具调用计数"""
        self.stats['total_tool_calls'] += 1

    def _auto_summarize(self, data: Any) -> str:
        """
        自动摘要数据

        Args:
            data: 原始数据

        Returns:
            摘要文本
        """
        # 如果数据较小，不摘要
        if self._estimate_token_size(data) < 500:
            return str(data)

        # 使用规则摘要
        if isinstance(data, dict):
            # 提取关键字段
            if 'answer' in data:
                return data['answer'][:300]
            elif 'content' in data:
                return data['content'][:300]
            elif 'results' in data:
                result_count = len(data['results']) if isinstance(data['results'], list) else 0
                return f"查询返回 {result_count} 条结果"
            elif 'data' in data:
                return self._auto_summarize(data['data'])

        elif isinstance(data, list):
            return f"列表包含 {len(data)} 个项目"

        elif isinstance(data, str):
            return data[:300] + "..." if len(data) > 300 else data

        # 默认: 转字符串并截断
        data_str = str(data)
        return data_str[:300] + "..." if len(data_str) > 300 else data_str

    def _estimate_token_size(self, data: Any) -> int:
        """
        估算数据的 token 大小

        Args:
            data: 数据

        Returns:
            估算的 token 数
        """
        try:
            data_str = json.dumps(data, ensure_ascii=False)
        except (TypeError, ValueError):
            data_str = str(data)

        # 粗略估算: 中文字符约1个token，英文约4字符1个token
        chinese_chars = sum(1 for c in data_str if '\u4e00' <= c <= '\u9fff')
        other_chars = len(data_str) - chinese_chars

        return chinese_chars + other_chars // 4

    def get_summary(self) -> Dict[str, Any]:
        """
        获取上下文摘要（用于调试和监控）

        Returns:
            摘要字典
        """
        return {
            'session_id': self.session_id,
            'stats': self.stats,
            'tasks_count': len(self.task_results),
            'stages_count': len(self.stage_outputs),
            'successful_tasks': sum(
                1 for t in self.task_results.values() if t.success
            ),
            'failed_tasks': len(self.stats['failed_tasks']),
            'total_data_size': sum(
                t.token_size for t in self.task_results.values()
            )
        }

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典（扩展基类）"""
        base_dict = super().to_dict()

        base_dict.update({
            'task_results': {
                tid: {
                    'task_id': tr.task_id,
                    'success': tr.success,
                    'error': tr.error,
                    'token_size': tr.token_size,
                    'timestamp': tr.timestamp.isoformat()
                }
                for tid, tr in self.task_results.items()
            },
            'stage_outputs': {
                sid: {
                    'stage_id': so.stage_id,
                    'stage_name': so.stage_name,
                    'success': so.success,
                    'tasks_completed': so.tasks_completed,
                    'timestamp': so.timestamp.isoformat()
                }
                for sid, so in self.stage_outputs.items()
            },
            'stats': self.stats
        })

        return base_dict
