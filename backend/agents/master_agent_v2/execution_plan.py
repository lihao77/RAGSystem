# -*- coding: utf-8 -*-
"""
执行计划模型

定义 DAG 结构和任务节点
"""

from typing import List, Dict, Any, Optional, Set
from dataclasses import dataclass, field
from enum import Enum


class TaskStatus(Enum):
    """任务状态"""
    PENDING = "pending"  # 等待执行
    READY = "ready"  # 依赖满足，可执行
    RUNNING = "running"  # 执行中
    COMPLETED = "completed"  # 已完成
    FAILED = "failed"  # 失败
    SKIPPED = "skipped"  # 跳过（依赖失败）


class ExecutionMode(Enum):
    """执行模式"""
    SIMPLE = "simple"  # 单智能体
    SEQUENTIAL = "sequential"  # 顺序执行多智能体
    PARALLEL = "parallel"  # 并行执行（部分任务）
    DAG = "dag"  # 完整 DAG 模式


@dataclass
class SubTask:
    """子任务节点"""
    id: str  # 唯一标识（如 "task_1"）
    order: int  # 执行顺序
    description: str  # 任务描述
    agent_name: str  # 执行的智能体名称
    depends_on: List[str] = field(default_factory=list)  # 依赖的任务 ID
    status: TaskStatus = TaskStatus.PENDING
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    retry_count: int = 0
    execution_time: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            'id': self.id,
            'order': self.order,
            'description': self.description,
            'agent_name': self.agent_name,
            'depends_on': self.depends_on,
            'status': self.status.value,
            'result': self.result,
            'error': self.error,
            'retry_count': self.retry_count,
            'execution_time': self.execution_time
        }

    def is_ready(self, completed_tasks: Set[str]) -> bool:
        """判断是否准备就绪（所有依赖都已完成）"""
        if self.status != TaskStatus.PENDING:
            return False
        return all(dep_id in completed_tasks for dep_id in self.depends_on)


@dataclass
class ExecutionPlan:
    """执行计划"""
    mode: ExecutionMode  # 执行模式
    reasoning: str  # 规划原因
    subtasks: List[SubTask]  # 子任务列表
    estimated_time: Optional[float] = None  # 预估执行时间（秒）
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典（用于 JSON 序列化和前端展示）"""
        return {
            'mode': self.mode.value,
            'reasoning': self.reasoning,
            'subtasks': [task.to_dict() for task in self.subtasks],
            'estimated_time': self.estimated_time,
            'metadata': self.metadata,
            # DAG 可视化数据
            'dag': self._build_dag_structure()
        }

    def _build_dag_structure(self) -> Dict[str, Any]:
        """构建 DAG 可视化结构"""
        nodes = []
        edges = []

        for task in self.subtasks:
            nodes.append({
                'id': task.id,
                'label': f"{task.order}. {task.agent_name}",
                'description': task.description,
                'status': task.status.value
            })

            for dep_id in task.depends_on:
                edges.append({
                    'from': dep_id,
                    'to': task.id
                })

        return {
            'nodes': nodes,
            'edges': edges
        }

    def get_ready_tasks(self, completed_task_ids: Set[str]) -> List[SubTask]:
        """获取所有准备就绪的任务（可并行执行）"""
        ready_tasks = []
        for task in self.subtasks:
            if task.is_ready(completed_task_ids):
                ready_tasks.append(task)
        return ready_tasks

    def get_task_by_id(self, task_id: str) -> Optional[SubTask]:
        """根据 ID 获取任务"""
        for task in self.subtasks:
            if task.id == task_id:
                return task
        return None

    def update_task_status(self, task_id: str, status: TaskStatus, result: Optional[Dict] = None, error: Optional[str] = None):
        """更新任务状态"""
        task = self.get_task_by_id(task_id)
        if task:
            task.status = status
            if result is not None:
                task.result = result
            if error is not None:
                task.error = error

    def is_completed(self) -> bool:
        """判断所有任务是否完成"""
        return all(
            task.status in [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.SKIPPED]
            for task in self.subtasks
        )

    def get_completion_percentage(self) -> float:
        """获取完成百分比"""
        if not self.subtasks:
            return 100.0

        completed_count = sum(
            1 for task in self.subtasks
            if task.status in [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.SKIPPED]
        )
        return (completed_count / len(self.subtasks)) * 100
