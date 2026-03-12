# -*- coding: utf-8 -*-
"""
Large Payload Observation Formatter

处理大数据结果，需要落盘到文件。
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from .base import BaseObservationFormatter, FormatContext

if TYPE_CHECKING:
    from tools.result_schema import ToolExecutionResult


class LargePayloadFormatter(BaseObservationFormatter):
    """
    大数据结果格式化器。

    当数据超过阈值时，将数据保存到文件，返回文件引用。
    """

    name = "large_payload"
    priority = 30

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        """当数据大小超过阈值时处理。"""
        if context.no_truncate:
            return False

        size = self._estimate_size_fast(result.content)
        return size > context.large_data_threshold

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        """格式化大数据结果为文件引用。"""
        if context.artifact_store is None:
            raise RuntimeError("LargePayloadFormatter 需要 artifact_store")

        pure_data = result.content
        summary = result.summary
        metadata = result.metadata or {}
        answer = result.answer
        approval_message = metadata.get("approval_message", "")

        # 记录物化
        estimated_size = self._estimate_size_fast(pure_data)
        self._record_materialization(result, context, estimated_size, used_artifact=True)

        # 保存到文件
        if isinstance(pure_data, str):
            artifact = context.artifact_store.save_text(
                session_id=None,
                tool_name=result.tool_name or context.tool_name,
                content=pure_data,
                suffix=".txt",
            )
        else:
            artifact = context.artifact_store.save_json(
                session_id=None,
                tool_name=result.tool_name or context.tool_name,
                data=pure_data,
            )
        result.artifacts.append(artifact)

        # 构建元信息
        meta_info_parts = []
        if summary:
            meta_info_parts.append(summary)

        total_count = metadata.get("total_count")
        data_type = metadata.get("data_type", "List")
        fields = metadata.get("fields", [])

        if total_count:
            meta_info_parts.append(f"{data_type}: {total_count} 条记录")

        if fields:
            field_names = [field["name"] for field in fields[:5]]
            field_str = ", ".join(field_names)
            if len(fields) > 5:
                field_str += f" 等 {len(fields)} 个字段"
            meta_info_parts.append(f"字段: {field_str}")

        meta_info = " | ".join(meta_info_parts) if meta_info_parts else "数据量过大"

        # 构建输出
        parts = []
        if answer:
            parts.append(f"✅ {answer}\n")
        if approval_message:
            parts.append(f"👤 用户批注: {approval_message}\n")

        parts.append(f"📁 数据已存储: {artifact.path}")
        parts.append(f"📊 {meta_info}")
        parts.append("💡 后续工具可直接使用此文件路径作为参数")

        # 添加样本
        if metadata.get("sample"):
            sample = metadata["sample"]
            sample_str = json.dumps(sample, ensure_ascii=False)
            if len(sample_str) > 200:
                sample_str = sample_str[:200] + "..."
            parts.append(f"📝 样本: {sample_str}")

        return "\n".join(parts)
