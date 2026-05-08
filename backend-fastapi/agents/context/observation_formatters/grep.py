# -*- coding: utf-8 -*-
"""
Grep 工具 Observation Formatter

只输出 ripgrep 的 output 文本，剔除 matches（重复）、durationMs 等噪声。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.contracts.result_models import ToolExecutionResult


class GrepObservationFormatter(BaseObservationFormatter):
    """Grep 工具结果格式化器。"""

    name = "grep"
    priority = 36

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        return context.tool_name == "grep" and context.mode == "inline"

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        content = result.content

        estimated_size = self._estimate_size_fast(content)
        self._record_materialization(result, context, estimated_size, used_artifact=False)

        if not isinstance(content, dict):
            return str(content)

        error = content.get("error")
        if error:
            return f"[ERROR] {error}"

        output = content.get("output", "")
        count = content.get("count", 0)
        truncated = content.get("truncated", False)

        if not output or count == 0:
            return "未找到匹配"

        header = f"找到 {count} 个匹配"
        if truncated:
            header += "（结果已截断）"

        return f"{header}\n{output}"
