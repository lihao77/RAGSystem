# -*- coding: utf-8 -*-
"""
Observation Formatter 注册表

负责管理和分发格式化策略。
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, List, Optional, Type

if TYPE_CHECKING:
    from .base import BaseObservationFormatter, FormatContext
    from tools.contracts.result_models import ToolExecutionResult


class ObservationFormatterRegistry:
    """
    Observation Formatter 注册表。

    管理所有格式化策略，根据工具结果选择最合适的策略。
    """

    def __init__(self):
        self._formatters: List[BaseObservationFormatter] = []
        self._logger = logging.getLogger(f"{__name__}.ObservationFormatterRegistry")

    def register(self, formatter: BaseObservationFormatter) -> None:
        """
        注册一个格式化策略。

        Args:
            formatter: 格式化策略实例
        """
        self._formatters.append(formatter)
        # 按优先级排序
        self._formatters.sort(key=lambda f: f.priority)
        self._logger.debug(f"注册格式化策略: {formatter.name} (优先级: {formatter.priority})")

    def unregister(self, formatter_class: Type[BaseObservationFormatter]) -> None:
        """
        注销一个格式化策略。

        Args:
            formatter_class: 要注销的格式化策略类
        """
        self._formatters = [
            f for f in self._formatters if not isinstance(f, formatter_class)
        ]

    def get_formatter(
        self,
        result: ToolExecutionResult,
        context: FormatContext,
    ) -> Optional[BaseObservationFormatter]:
        """
        获取能处理此结果的最佳格式化策略。

        按优先级顺序遍历所有策略，返回第一个能处理的。

        Args:
            result: 工具执行结果
            context: 格式化上下文

        Returns:
            最佳格式化策略，如果没有找到则返回 None
        """
        for formatter in self._formatters:
            if formatter.can_handle(result, context):
                self._logger.debug(
                    f"选择格式化策略: {formatter.name} for tool {context.tool_name}"
                )
                return formatter

        self._logger.warning(f"没有找到合适的格式化策略 for tool {context.tool_name}")
        return None

    def format(
        self,
        result: ToolExecutionResult,
        context: FormatContext,
    ) -> str:
        """
        格式化工具结果为 observation 字符串。

        Args:
            result: 工具执行结果
            context: 格式化上下文

        Returns:
            格式化后的 observation 字符串

        Raises:
            RuntimeError: 如果没有找到合适的格式化策略
        """
        # 错误结果特殊处理
        if not result.success:
            return f"[ERROR] {result.content or '未知错误'}"

        formatter = self.get_formatter(result, context)

        if formatter is None:
            raise RuntimeError(f"没有可用的格式化策略 for tool {context.tool_name}")

        observation = formatter.format(result, context)

        # 统一追加 llm_hint（如果存在）
        if result.llm_hint:
            observation = f"{observation}\n{result.llm_hint}" if observation else result.llm_hint

        return observation

    def list_formatters(self) -> List[str]:
        """
        列出所有已注册的格式化策略。

        Returns:
            策略名称列表
        """
        return [f.name for f in self._formatters]


_formatter_registry: ObservationFormatterRegistry | None = None


def get_default_registry() -> ObservationFormatterRegistry:
    """
    获取默认的注册表实例（单例），并注册所有内置策略。

    Returns:
        配置好的注册表实例
    """
    global _formatter_registry
    if _formatter_registry is not None:
        return _formatter_registry

    from .bash import BashObservationFormatter
    from .chart import ChartObservationFormatter
    from .fallback import FallbackFormatter
    from .glob_fmt import GlobObservationFormatter
    from .grep import GrepObservationFormatter
    from .json_data import JsonDataFormatter
    from .large_payload import LargePayloadFormatter
    from .map import MapObservationFormatter
    from .skills import SkillsObservationFormatter
    from .text import TextDataFormatter
    from .web_fetch import WebFetchObservationFormatter

    registry = ObservationFormatterRegistry()

    # 按优先级注册内置策略（数字越小越先匹配）
    registry.register(SkillsObservationFormatter())      # 10
    registry.register(ChartObservationFormatter())        # 20
    registry.register(MapObservationFormatter())          # 21
    registry.register(LargePayloadFormatter())            # 30
    registry.register(BashObservationFormatter())         # 35
    registry.register(GrepObservationFormatter())         # 36
    registry.register(GlobObservationFormatter())         # 37
    registry.register(WebFetchObservationFormatter())     # 38
    registry.register(TextDataFormatter())                # 40
    registry.register(JsonDataFormatter())                # 41
    registry.register(FallbackFormatter())                # 999

    _formatter_registry = registry
    return registry
