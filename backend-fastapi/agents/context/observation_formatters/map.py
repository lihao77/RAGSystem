# -*- coding: utf-8 -*-
"""
Map Observation Formatter

处理地图生成工具的结果。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.result_schema import ToolExecutionResult


class MapObservationFormatter(BaseObservationFormatter):
    """
    地图结果格式化器。

    处理 generate_map 等地图工具的输出。
    """

    name = "map"
    priority = 21

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        """处理 output_type 为 map 的结果。"""
        return result.output_type == "map"

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        """格式化地图结果为 observation 字符串。"""
        content = result.content
        summary = result.summary or "地图生成成功"

        # 记录物化
        estimated_size = self._estimate_size_fast(content)
        self._record_materialization(result, context, estimated_size, used_artifact=False)

        # 地图通常是 HTML 文件
        if isinstance(content, str) and content.endswith(".html"):
            return f"✅ {summary}\n\n🗺️ 地图文件: {content}"

        return f"✅ {summary}\n\n🗺️ 地图数据已生成"
