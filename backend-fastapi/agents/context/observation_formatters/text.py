# -*- coding: utf-8 -*-
"""
Text Data Observation Formatter

处理纯文本结果。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.result_schema import ToolExecutionResult


class TextDataFormatter(BaseObservationFormatter):
    """
    文本结果格式化器。

    处理字符串类型的结果，如 read_document、read_file 等。
    """

    name = "text"
    priority = 40

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        """处理字符串内容或 output_type 为 text/markdown 的结果。"""
        if isinstance(result.content, str):
            return True
        return result.output_type in ("text", "markdown")

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        """格式化文本结果为 observation 字符串。"""
        content = result.content
        summary = result.summary
        metadata = result.metadata or {}
        approval_message = metadata.get("approval_message", "")

        # 记录物化
        estimated_size = self._estimate_size_fast(content)
        self._record_materialization(result, context, estimated_size, used_artifact=False)

        # 构建前缀
        prefix = f"✅ {summary}\n\n" if summary else "✅ 执行成功\n\n"
        if approval_message:
            prefix += f"👤 用户批注: {approval_message}\n\n"

        # 如果 content 不是字符串，转为字符串
        if not isinstance(content, str):
            content = str(content)

        return f"{prefix}{content}"
