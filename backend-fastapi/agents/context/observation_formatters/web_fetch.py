# -*- coding: utf-8 -*-
"""
WebFetch 工具 Observation Formatter

只输出页面内容，剔除 start_index/end_index/total_length 等分页元数据。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.contracts.result_models import ToolExecutionResult


class WebFetchObservationFormatter(BaseObservationFormatter):
    """WebFetch 工具结果格式化器。"""

    name = "web_fetch"
    priority = 38

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        return context.tool_name == "web_fetch" and context.mode == "inline"

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        content = result.content

        estimated_size = self._estimate_size_fast(content)
        self._record_materialization(result, context, estimated_size, used_artifact=False)

        if not isinstance(content, dict):
            return str(content)

        error = content.get("error")
        if error:
            return f"[ERROR] {error}"

        page_content = content.get("content", "")
        url = content.get("url", "")
        truncated = content.get("truncated", False)

        parts = []
        if url:
            parts.append(f"URL: {url}")

        if page_content:
            parts.append(page_content)

        if truncated:
            end_index = content.get("end_index", 0)
            total_length = content.get("total_length", 0)
            parts.append(f"（内容已截断，总长度 {total_length}，可用 start_index={end_index} 继续读取）")

        return "\n".join(parts) if parts else "页面内容为空"
