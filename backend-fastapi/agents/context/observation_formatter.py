# -*- coding: utf-8 -*-
"""Tool observation formatting helpers.

此模块现在使用策略模式，通过 ObservationFormatterRegistry 管理不同输出类型的格式化策略。
为了向后兼容，保留 ObservationFormatter 类作为外观模式。

新增工具格式化支持：
1. 在 observation_formatters/ 下创建新的策略类继承 BaseObservationFormatter
2. 在 get_default_registry() 中注册新策略
3. 或使用 ObservationFormatter.register_formatter() 动态注册

详见 observation_formatters/__init__.py
"""

from __future__ import annotations

import logging
from typing import Any

from agents.artifacts import ArtifactStore
from agents.monitoring.observation_window import ObservationWindowCollector
from tools.result_normalizer import ToolResultNormalizer
from tools.result_schema import ToolExecutionResult

from .observation_formatters import (
    BaseObservationFormatter,
    FormatContext,
    get_default_registry,
    ObservationFormatterRegistry,
)


class ObservationFormatter:
    """
    Format tool responses into compact observations for the next LLM turn.

    现在作为策略注册表的外观，保持向后兼容。
    内部使用 ObservationFormatterRegistry 分发到具体策略。
    """

    LARGE_DATA_THRESHOLD = 8000
    SUMMARY_MAX_LENGTH = 300

    def __init__(
        self,
        data_save_dir: str = "./static/temp_data",
        artifact_store: ArtifactStore | None = None,
        result_normalizer: ToolResultNormalizer | None = None,
        observation_window: ObservationWindowCollector | None = None,
    ):
        self.data_save_dir = data_save_dir
        self.observation_window = observation_window or ObservationWindowCollector()
        self.artifact_store = artifact_store or ArtifactStore(
            base_dir=data_save_dir,
            observation_window=self.observation_window,
        )
        self.result_normalizer = result_normalizer or ToolResultNormalizer(
            observation_window=self.observation_window,
        )
        self.logger = logging.getLogger(f"{__name__}.ObservationFormatter")

        # 使用默认注册表
        self._registry = get_default_registry()

    def format(
        self,
        result: Any,
        tool_name: str = None,
        is_skills_tool: bool = False,
        no_truncate: bool = False,
    ) -> str:
        """
        格式化工具结果为 observation 字符串。

        Args:
            result: 工具返回结果（任意格式）
            tool_name: 工具名称
            is_skills_tool: 是否为 Skills 工具
            no_truncate: 是否禁用截断

        Returns:
            格式化后的 observation 字符串
        """
        # 归一化为 ToolExecutionResult
        normalized = self.result_normalizer.normalize(result, tool_name=tool_name)

        # 构建格式化上下文
        context = FormatContext(
            tool_name=tool_name or "",
            is_skills_tool=is_skills_tool,
            no_truncate=no_truncate,
            artifact_store=self.artifact_store,
            observation_window=self.observation_window,
            large_data_threshold=self.LARGE_DATA_THRESHOLD,
        )

        # 使用注册表分发给具体策略
        try:
            return self._registry.format(normalized, context)
        except Exception as e:
            self.logger.error(f"格式化失败: {e}")
            # 保底：返回简单的错误信息
            if normalized.success:
                return f"✅ 执行成功\n\n{str(normalized.content)}"
            return f"❌ 错误: {normalized.content or '未知错误'}"

    def register_formatter(self, formatter: BaseObservationFormatter) -> None:
        """
        注册自定义格式化策略。

        Args:
            formatter: 自定义格式化策略实例

        Example:
            >>> formatter = ObservationFormatter()
            >>> formatter.register_formatter(MyCustomFormatter())
        """
        self._registry.register(formatter)
        self.logger.info(f"注册自定义格式化策略: {formatter.name}")

    def list_formatters(self) -> list[str]:
        """
        列出所有已注册的格式化策略。

        Returns:
            策略名称列表
        """
        return self._registry.list_formatters()


# 保持旧的方法作为内部工具函数（供策略类使用）
def _estimate_size_fast(data: Any) -> int:
    """快速估算数据大小（供旧代码兼容）。"""
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
