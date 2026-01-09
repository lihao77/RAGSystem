# -*- coding: utf-8 -*-
"""
执行计划 - MasterAgent V2 的执行计划抽象

支持三种执行模式:
1. DirectAnswerPlan: 直接回答
2. StaticExecutionPlan: 静态 DAG 计划
3. HybridExecutionPlan: 混合模式计划
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field
from enum import Enum


class ExecutionMode(Enum):
    """执行模式"""
    DIRECT_ANSWER = "direct_answer"
    STATIC_PLAN = "static_plan"
    HYBRID_PLAN = "hybrid_plan"


class FallbackStrategy(Enum):
    """失败降级策略"""
    SKIP = "skip"              # 跳过，标记为可选
    RETRY = "retry"            # 重试
    USE_CACHE = "use_cache"    # 使用缓存
    ASK_LLM = "ask_llm"        # 询问 LLM 替代方案
    ABORT = "abort"            # 中止整个流程


@dataclass
class TaskNode:
    """任务节点"""
    id: str
    description: str
    agent: str
    depends_on: List[str] = field(default_factory=list)
    estimated_complexity: int = 3  # 1-5
    optional: bool = False  # 是否可选
    fallback_strategy: FallbackStrategy = FallbackStrategy.RETRY
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Stage:
    """执行阶段（混合模式）"""
    stage_id: str
    name: str
    type: str  # "static" 或 "dynamic"
    description: str
    depends_on: List[str] = field(default_factory=list)

    # type = static 时使用
    subtasks: List[TaskNode] = field(default_factory=list)

    # type = dynamic 时使用
    max_rounds: int = 5
    available_agents: List[str] = field(default_factory=list)
    goal: str = ""

    metadata: Dict[str, Any] = field(default_factory=dict)


class ExecutionPlan(ABC):
    """执行计划基类"""

    def __init__(self, mode: ExecutionMode):
        self.mode = mode

    @abstractmethod
    def get_summary(self) -> Dict[str, Any]:
        """获取计划摘要"""
        pass

    @abstractmethod
    def validate(self) -> bool:
        """验证计划的有效性"""
        pass


class DirectAnswerPlan(ExecutionPlan):
    """直接回答计划（简单对话）"""

    def __init__(self, answer: str, reasoning: str = ""):
        super().__init__(ExecutionMode.DIRECT_ANSWER)
        self.answer = answer
        self.reasoning = reasoning

    def get_summary(self) -> Dict[str, Any]:
        return {
            'mode': self.mode.value,
            'answer_length': len(self.answer),
            'reasoning': self.reasoning
        }

    def validate(self) -> bool:
        return bool(self.answer)


class StaticExecutionPlan(ExecutionPlan):
    """静态执行计划（预定义 DAG）"""

    def __init__(
        self,
        subtasks: List[Dict[str, Any]],
        strategy: str = "sequential",
        reasoning: str = ""
    ):
        super().__init__(ExecutionMode.STATIC_PLAN)
        self.reasoning = reasoning
        self.strategy = strategy  # "sequential" 或 "parallel"

        # 转换为 TaskNode 对象
        self.tasks: List[TaskNode] = []
        for task_dict in subtasks:
            fallback_str = task_dict.get('fallback_strategy', 'retry')
            try:
                fallback = FallbackStrategy(fallback_str)
            except ValueError:
                fallback = FallbackStrategy.RETRY

            task_node = TaskNode(
                id=task_dict['id'],
                description=task_dict['description'],
                agent=task_dict['agent'],
                depends_on=task_dict.get('depends_on', []),
                estimated_complexity=task_dict.get('estimated_complexity', 3),
                optional=task_dict.get('optional', False),
                fallback_strategy=fallback,
                metadata=task_dict.get('metadata', {})
            )
            self.tasks.append(task_node)

    def get_summary(self) -> Dict[str, Any]:
        return {
            'mode': self.mode.value,
            'total_tasks': len(self.tasks),
            'strategy': self.strategy,
            'reasoning': self.reasoning,
            'agents_involved': list(set(t.agent for t in self.tasks)),
            'optional_tasks': sum(1 for t in self.tasks if t.optional)
        }

    def validate(self) -> bool:
        """验证计划有效性（检查依赖和循环）"""
        if not self.tasks:
            return False

        # 检查任务ID唯一性
        task_ids = [t.id for t in self.tasks]
        if len(task_ids) != len(set(task_ids)):
            return False

        # 检查依赖是否存在
        for task in self.tasks:
            for dep_id in task.depends_on:
                if dep_id not in task_ids:
                    return False

        # 检查循环依赖 (使用拓扑排序)
        try:
            self._topological_sort()
            return True
        except ValueError:
            return False

    def _topological_sort(self) -> List[List[TaskNode]]:
        """
        拓扑排序，返回分层结构

        Returns:
            [[layer0_tasks], [layer1_tasks], ...]

        Raises:
            ValueError: 如果存在循环依赖
        """
        # 构建依赖图
        task_dict = {t.id: t for t in self.tasks}
        dependency_graph = {t.id: [] for t in self.tasks}

        for task in self.tasks:
            for dep_id in task.depends_on:
                dependency_graph[dep_id].append(task.id)

        # 计算入度
        in_degree = {t.id: len(t.depends_on) for t in self.tasks}

        layers = []
        visited = set()

        while len(visited) < len(self.tasks):
            # 找出当前入度为 0 的任务
            current_layer = []
            for task_id, degree in in_degree.items():
                if task_id not in visited and degree == 0:
                    current_layer.append(task_dict[task_id])

            if not current_layer:
                raise ValueError("检测到循环依赖")

            layers.append(current_layer)

            # 更新入度
            for task_node in current_layer:
                visited.add(task_node.id)
                for child_id in dependency_graph.get(task_node.id, []):
                    in_degree[child_id] -= 1

        return layers


class HybridExecutionPlan(ExecutionPlan):
    """混合执行计划（宏观静态 + 微观动态）"""

    def __init__(
        self,
        stages: List[Dict[str, Any]],
        reasoning: str = ""
    ):
        super().__init__(ExecutionMode.HYBRID_PLAN)
        self.reasoning = reasoning

        # 转换为 Stage 对象
        self.stages: List[Stage] = []
        for stage_dict in stages:
            # 处理子任务（如果是静态阶段）
            subtasks = []
            if stage_dict['type'] == 'static' and 'subtasks' in stage_dict:
                for task_dict in stage_dict['subtasks']:
                    fallback_str = task_dict.get('fallback_strategy', 'retry')
                    try:
                        fallback = FallbackStrategy(fallback_str)
                    except ValueError:
                        fallback = FallbackStrategy.RETRY

                    subtasks.append(TaskNode(
                        id=task_dict['id'],
                        description=task_dict['description'],
                        agent=task_dict['agent'],
                        depends_on=task_dict.get('depends_on', []),
                        estimated_complexity=task_dict.get('estimated_complexity', 3),
                        optional=task_dict.get('optional', False),
                        fallback_strategy=fallback
                    ))

            stage = Stage(
                stage_id=stage_dict['stage_id'],
                name=stage_dict['name'],
                type=stage_dict['type'],
                description=stage_dict['description'],
                depends_on=stage_dict.get('depends_on', []),
                subtasks=subtasks,
                max_rounds=stage_dict.get('max_rounds', 5),
                available_agents=stage_dict.get('available_agents', []),
                goal=stage_dict.get('goal', stage_dict['description']),
                metadata=stage_dict.get('metadata', {})
            )
            self.stages.append(stage)

    def get_summary(self) -> Dict[str, Any]:
        static_stages = sum(1 for s in self.stages if s.type == 'static')
        dynamic_stages = sum(1 for s in self.stages if s.type == 'dynamic')

        total_static_tasks = sum(
            len(s.subtasks) for s in self.stages if s.type == 'static'
        )

        return {
            'mode': self.mode.value,
            'total_stages': len(self.stages),
            'static_stages': static_stages,
            'dynamic_stages': dynamic_stages,
            'total_static_tasks': total_static_tasks,
            'reasoning': self.reasoning,
            'stage_names': [s.name for s in self.stages]
        }

    def validate(self) -> bool:
        """验证计划有效性"""
        if not self.stages:
            return False

        # 检查阶段ID唯一性
        stage_ids = [s.stage_id for s in self.stages]
        if len(stage_ids) != len(set(stage_ids)):
            return False

        # 检查依赖是否存在
        for stage in self.stages:
            for dep_id in stage.depends_on:
                if dep_id not in stage_ids:
                    return False

        # 检查循环依赖
        try:
            self._topological_sort_stages()
            return True
        except ValueError:
            return False

    def _topological_sort_stages(self) -> List[Stage]:
        """
        拓扑排序阶段

        Returns:
            排序后的阶段列表

        Raises:
            ValueError: 如果存在循环依赖
        """
        stage_dict = {s.stage_id: s for s in self.stages}
        in_degree = {s.stage_id: len(s.depends_on) for s in self.stages}

        result = []
        visited = set()

        while len(visited) < len(self.stages):
            # 找出入度为 0 的阶段
            ready = []
            for stage_id, degree in in_degree.items():
                if stage_id not in visited and degree == 0:
                    ready.append(stage_dict[stage_id])

            if not ready:
                raise ValueError("检测到循环依赖")

            # 按原始顺序排序（保持用户定义的顺序）
            ready.sort(key=lambda s: self.stages.index(s))
            result.extend(ready)

            # 更新入度
            for stage in ready:
                visited.add(stage.stage_id)
                # 减少依赖此阶段的其他阶段的入度
                for other_stage in self.stages:
                    if stage.stage_id in other_stage.depends_on:
                        in_degree[other_stage.stage_id] -= 1

        return result


def create_execution_plan(analysis: Dict[str, Any]) -> ExecutionPlan:
    """
    根据任务分析结果创建执行计划

    Args:
        analysis: 任务分析结果

    Returns:
        ExecutionPlan 实例

    Raises:
        ValueError: 如果模式不支持或计划无效
    """
    mode = analysis.get('mode')

    if mode == 'direct_answer':
        plan = DirectAnswerPlan(
            answer=analysis['answer'],
            reasoning=analysis.get('reasoning', '')
        )

    elif mode == 'static_plan':
        plan = StaticExecutionPlan(
            subtasks=analysis['subtasks'],
            strategy=analysis.get('execution_strategy', 'sequential'),
            reasoning=analysis.get('reasoning', '')
        )

    elif mode == 'hybrid_plan':
        plan = HybridExecutionPlan(
            stages=analysis['stages'],
            reasoning=analysis.get('reasoning', '')
        )

    else:
        raise ValueError(f"不支持的执行模式: {mode}")

    # 验证计划
    if not plan.validate():
        raise ValueError(f"执行计划验证失败: {plan.get_summary()}")

    return plan
