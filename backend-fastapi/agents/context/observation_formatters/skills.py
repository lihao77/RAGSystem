# -*- coding: utf-8 -*-
"""
Skills 工具 Observation Formatter

处理 Skills 工具的结果，提取 main_content 等特殊字段。
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Dict

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.result_schema import ToolExecutionResult


class SkillsObservationFormatter(BaseObservationFormatter):
    """
    Skills 工具结果格式化器。

    特点：
    1. 优先提取 content/main_content 字段
    2. 保留 summary 和 metadata
    3. 不需要大数据物化
    """

    name = "skills"
    priority = 10  # 高优先级

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        """当明确标记为 Skills 工具时处理。"""
        return context.is_skills_tool

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        """格式化 Skills 结果为 observation 字符串。"""
        pure_data = result.content
        summary = result.summary

        # 记录物化（Skills 不走大数据物化）
        estimated_size = self._estimate_size_fast(pure_data)
        self._record_materialization(result, context, estimated_size, used_artifact=False)

        # 如果是字典，尝试提取 content/main_content
        if isinstance(pure_data, dict):
            skill_content = pure_data.get("main_content") or pure_data.get("content")
            if skill_content:
                return f"✅ {summary}\n\n{skill_content}" if summary else skill_content

        # 默认返回完整 JSON
        data: Dict[str, Any] = {"results": pure_data}
        if result.metadata:
            data["metadata"] = result.metadata
        if summary:
            data["summary"] = summary
        if result.answer:
            data["answer"] = result.answer

        return json.dumps(data, ensure_ascii=False, indent=2)
