# -*- coding: utf-8 -*-
"""
JSON Data Observation Formatter

处理 JSON 数据结果（列表、字典）。
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.result_schema import ToolExecutionResult


class JsonDataFormatter(BaseObservationFormatter):
    """
    JSON 数据结果格式化器。

    处理 dict/list 类型的结果，格式化为 JSON 代码块。
    """

    name = "json"
    priority = 41  # 在 TextFormatter 之后，作为 dict/list 的备选

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        """处理字典、列表或 output_type 为 json 的结果。"""
        if isinstance(result.content, (dict, list)):
            return True
        return result.output_type == "json"

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        """格式化 JSON 结果为 observation 字符串。"""
        content = result.content
        summary = result.summary
        answer = result.answer
        metadata = result.metadata or {}
        approval_message = metadata.get("approval_message", "")

        # 记录物化
        estimated_size = self._estimate_size_fast(content)
        self._record_materialization(result, context, estimated_size, used_artifact=False)

        # 转换为 JSON 字符串
        content_str = (
            json.dumps(content, ensure_ascii=False, indent=2)
            if isinstance(content, (dict, list))
            else str(content)
        )

        # 如果有 answer，使用特殊格式
        if answer:
            prefix = f"✅ {answer}\n\n"
            if approval_message:
                prefix += f"👤 用户批注: {approval_message}\n\n"
            return f"{prefix}📊 数据详情:\n```json\n{content_str[:2000]}\n```"

        # 默认格式
        prefix = f"✅ {summary}\n\n" if summary else "✅ 执行成功\n\n"
        if approval_message:
            prefix += f"👤 用户批注: {approval_message}\n\n"

        return f"{prefix}```json\n{content_str}\n```"
