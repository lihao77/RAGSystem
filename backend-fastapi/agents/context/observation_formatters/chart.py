# -*- coding: utf-8 -*-
"""
Chart Observation Formatter

处理图表生成工具的结果。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.result_schema import ToolExecutionResult


class ChartObservationFormatter(BaseObservationFormatter):
    """
    图表结果格式化器。

    处理 generate_chart 等可视化工具的输出。
    """

    name = "chart"
    priority = 20

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        """处理 output_type 为 chart 的结果。"""
        return result.output_type == "chart"

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        """格式化图表结果为 observation 字符串。"""
        content = result.content
        summary = result.summary or "图表生成成功"
        presentation = result.metadata.get("presentation", {}) if isinstance(result.metadata, dict) else {}

        # 记录物化
        estimated_size = self._estimate_size_fast(content)
        self._record_materialization(result, context, estimated_size, used_artifact=False)

        if isinstance(content, dict) and presentation:
            candidate_id = presentation.get("candidate_id", "")
            config_path = presentation.get("config_path", content.get("config_path", ""))
            status = presentation.get("status", "")
            preview = content.get("preview") if isinstance(content.get("preview"), dict) else {}
            title = preview.get("title") or content.get("title") or "未命名图表"
            chart_type = presentation.get("chart_type") or content.get("chart_type") or preview.get("chart_type") or ""

            parts = [f"✅ {summary}"]
            if candidate_id:
                parts.append(f"候选ID: {candidate_id}")
            if chart_type:
                parts.append(f"类型: {chart_type}")
            parts.append(f"标题: {title}")
            if config_path:
                parts.append(f"配置文件: {config_path}")

            if status in {"draft", "revised"}:
                parts.append("下一步: 可读取或修改配置，确认后调用 present_chart。")
            elif status in {"selected", "published"}:
                parts.append("该图表已被选中，将在最终答案生成后发布到前端。")
            return "\n".join(parts)

        if isinstance(content, str) and (content.endswith(".html") or content.endswith(".png")):
            return f"✅ {summary}\n\n📊 图表文件: {content}"

        return f"✅ {summary}\n\n📊 图表数据已生成"
