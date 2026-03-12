# -*- coding: utf-8 -*-
"""
Fallback Observation Formatter

保底策略，处理所有未被其他策略处理的情况。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.result_schema import ToolExecutionResult


class FallbackFormatter(BaseObservationFormatter):
    """
    保底格式化器。

    当没有其他策略能处理时，使用简单的字符串转换。
    这个策略总是可以处理任何结果。
    """

    name = "fallback"
    priority = 999  # 最低优先级，最后匹配

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        """保底策略，总是返回 True。"""
        return True

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        """使用简单的字符串转换。"""
        content = result.content
        summary = result.summary

        # 记录物化
        estimated_size = self._estimate_size_fast(content)
        self._record_materialization(result, context, estimated_size, used_artifact=False)

        prefix = f"✅ {summary}\n\n" if summary else "✅ 执行成功\n\n"

        return f"{prefix}{str(content)}"
