# -*- coding: utf-8 -*-
"""
增强的上下文管理器

提供结构化的上下文传递和智能压缩
"""

import json
import logging
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class TaskResult:
    """任务结果"""
    task_id: str
    description: str
    agent_name: str
    success: bool
    content: Any  # 可以是字符串、字典、列表等
    data: Optional[Dict[str, Any]] = None
    execution_time: float = 0.0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            'task_id': self.task_id,
            'description': self.description,
            'agent_name': self.agent_name,
            'success': self.success,
            'content': self.content,
            'data': self.data,
            'execution_time': self.execution_time,
            'error': self.error
        }

    def to_summary(self, max_length: int = 500) -> str:
        """生成简洁的摘要"""
        if not self.success:
            return f"❌ {self.description} - 失败: {self.error}"

        content_str = ""
        if isinstance(self.content, str):
            content_str = self.content
        else:
            content_str = json.dumps(self.content, ensure_ascii=False, indent=2)

        if len(content_str) > max_length:
            content_str = content_str[:max_length] + "..."

        return f"✅ {self.description}\n结果: {content_str}"


class EnhancedContext:
    """
    增强的上下文管理器

    功能：
    1. 结构化存储任务结果
    2. 智能上下文压缩
    3. 依赖结果提取
    4. 上下文版本控制
    """

    def __init__(self, session_id: str):
        """
        初始化上下文管理器

        Args:
            session_id: 会话 ID
        """
        self.session_id = session_id
        self.task_results: Dict[str, TaskResult] = {}  # task_id -> TaskResult
        self.metadata: Dict[str, Any] = {}
        self.version = 1

    def store_task_result(self, task_result: TaskResult):
        """
        存储任务结果

        Args:
            task_result: 任务结果对象
        """
        self.task_results[task_result.task_id] = task_result
        logger.info(f"[EnhancedContext] 存储任务结果: {task_result.task_id}")

    def get_task_result(self, task_id: str) -> Optional[TaskResult]:
        """
        获取任务结果

        Args:
            task_id: 任务 ID

        Returns:
            TaskResult 或 None
        """
        return self.task_results.get(task_id)

    def get_dependency_results(self, dependency_ids: List[str]) -> List[TaskResult]:
        """
        获取依赖任务的结果

        Args:
            dependency_ids: 依赖任务的 ID 列表

        Returns:
            TaskResult 列表
        """
        results = []
        for task_id in dependency_ids:
            result = self.get_task_result(task_id)
            if result:
                results.append(result)
        return results

    def build_context_for_task(
        self,
        task_description: str,
        dependency_ids: List[str],
        max_length: int = 2000
    ) -> str:
        """
        为新任务构建增强的上下文描述

        Args:
            task_description: 任务描述
            dependency_ids: 依赖任务的 ID
            max_length: 最大上下文长度

        Returns:
            增强后的任务描述
        """
        if not dependency_ids:
            return task_description

        dep_results = self.get_dependency_results(dependency_ids)
        if not dep_results:
            return task_description

        context_parts = [task_description, "\n\n【前置任务结果】"]

        total_length = len(task_description) + 20
        summary_length = max_length - total_length

        # 为每个依赖任务生成摘要
        for result in dep_results:
            summary = result.to_summary(max_length=summary_length // len(dep_results))
            context_parts.append(f"\n{summary}")

        return "\n".join(context_parts)

    def compress_context(self, max_tokens: int = 4000) -> Dict[str, Any]:
        """
        压缩上下文（保留关键信息）

        Args:
            max_tokens: 最大 token 数（粗略估算）

        Returns:
            压缩后的上下文字典
        """
        compressed = {
            'session_id': self.session_id,
            'version': self.version,
            'task_count': len(self.task_results),
            'task_summaries': []
        }

        # 计算每个任务的摘要
        for task_id, result in self.task_results.items():
            compressed['task_summaries'].append({
                'id': task_id,
                'description': result.description,
                'success': result.success,
                'summary': result.to_summary(max_length=200)
            })

        return compressed

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典（用于序列化）"""
        return {
            'session_id': self.session_id,
            'task_results': {k: v.to_dict() for k, v in self.task_results.items()},
            'metadata': self.metadata,
            'version': self.version
        }

    def get_all_results_summary(self) -> str:
        """获取所有任务结果的汇总"""
        if not self.task_results:
            return "（无任务结果）"

        summaries = []
        for task_id, result in self.task_results.items():
            summaries.append(result.to_summary())

        return "\n\n".join(summaries)
