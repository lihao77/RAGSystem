# -*- coding: utf-8 -*-
"""
Observation Formatter 抽象基类

定义所有格式化策略的通用接口。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, Optional

if TYPE_CHECKING:
    from agents.artifacts import ArtifactStore
    from agents.monitoring.observation_window import ObservationWindowCollector
    from tools.result_schema import ToolExecutionResult


@dataclass
class FormatContext:
    """
    格式化上下文，传递所有格式化所需的信息。

    Attributes:
        tool_name: 工具名称
        is_skills_tool: 是否为 Skills 工具
        no_truncate: 是否禁用截断
        artifact_store: Artifact 存储服务
        observation_window: 观察窗口收集器
        large_data_threshold: 大数据阈值
    """
    tool_name: str = ""
    session_id: Optional[str] = None
    is_skills_tool: bool = False
    no_truncate: bool = False
    artifact_store: Optional[Any] = None  # ArtifactStore
    observation_window: Optional[Any] = None  # ObservationWindowCollector
    large_data_threshold: int = 8000
    snippet_limit: int = 2000
    artifact_ttl_seconds: Optional[int] = None


class BaseObservationFormatter(ABC):
    """
    Observation Formatter 抽象基类。

    所有具体的格式化策略必须继承此类并实现 format 方法。
    """

    # 策略名称，用于注册和日志
    name: str = "base"

    # 策略优先级（数字越小优先级越高，用于多个策略都匹配时）
    priority: int = 100

    @abstractmethod
    def can_handle(self, result: ToolExecutionResult, context: FormatContext) -> bool:
        """
        判断此策略是否能处理给定的结果。

        Args:
            result: 工具执行结果
            context: 格式化上下文

        Returns:
            True 如果能处理，False 否则
        """
        ...

    @abstractmethod
    def format(self, result: ToolExecutionResult, context: FormatContext) -> str:
        """
        将工具结果格式化为 observation 字符串。

        Args:
            result: 工具执行结果
            context: 格式化上下文

        Returns:
            格式化后的 observation 字符串
        """
        ...

    def _estimate_size_fast(self, data: Any) -> int:
        """
        快速估算数据大小（字符数）。

        Args:
            data: 任意数据

        Returns:
            估算的字符数
        """
        import json

        if isinstance(data, str):
            return len(data)

        if isinstance(data, list):
            if len(data) == 0:
                return 2
            if len(data) <= 10:
                return len(json.dumps(data, ensure_ascii=False))
            sample = data[:10]
            sample_size = len(json.dumps(sample, ensure_ascii=False))
            return int(sample_size * (len(data) / len(sample)))

        if isinstance(data, dict):
            if len(data) == 0:
                return 2
            if len(data) <= 10:
                return len(json.dumps(data, ensure_ascii=False))
            sample = dict(list(data.items())[:10])
            sample_size = len(json.dumps(sample, ensure_ascii=False))
            return int(sample_size * (len(data) / len(sample)))

        return len(str(data))

    def _record_materialization(
        self,
        result: ToolExecutionResult,
        context: FormatContext,
        estimated_size: int,
        used_artifact: bool,
    ) -> None:
        """
        记录物化事件到观察窗口。

        Args:
            result: 工具执行结果
            context: 格式化上下文
            estimated_size: 估算大小
            used_artifact: 是否使用了 artifact
        """
        if context.observation_window is None:
            return

        context.observation_window.record_materialization(
            tool_name=result.tool_name or context.tool_name,
            output_type=result.output_type,
            estimated_size=estimated_size,
            threshold=context.large_data_threshold,
            used_artifact=used_artifact,
        )
