# -*- coding: utf-8 -*-
"""
Glob 工具 Observation Formatter

只列出匹配的文件名，剔除 durationMs 等噪声。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.contracts.result_models import ToolExecutionResult


class GlobObservationFormatter(BaseObservationFormatter):
    """Glob 工具结果格式化器。"""

    name = "glob"
    priority = 37

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        return context.tool_name == "glob" and context.mode == "inline"

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        content = result.content

        estimated_size = self._estimate_size_fast(content)
        self._record_materialization(result, context, estimated_size, used_artifact=False)

        if not isinstance(content, dict):
            return str(content)

        error = content.get("error")
        if error:
            return f"[ERROR] {error}"

        filenames = content.get("filenames", [])
        num_files = content.get("numFiles", len(filenames))
        truncated = content.get("truncated", False)

        if not filenames:
            return "未找到匹配文件"

        header = f"找到 {num_files} 个文件"
        if truncated:
            header += "（结果已截断）"

        return f"{header}\n" + "\n".join(filenames)
