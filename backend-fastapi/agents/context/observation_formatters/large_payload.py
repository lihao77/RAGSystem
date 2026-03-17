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
    _SOURCE_READ_TOOL_NAMES = {"read_file", "read_document"}

    def can_handle(self, result: "ToolExecutionResult", context: FormatContext) -> bool:
        """当 policy 决定 artifact_ref 模式时处理。"""
        return context.mode == "artifact_ref"

    def format(self, result: "ToolExecutionResult", context: FormatContext) -> str:
        """格式化大数据结果为文件引用。"""
        if context.artifact_store is None:
            raise RuntimeError("LargePayloadFormatter 需要 artifact_store")

        pure_data = result.content
        summary = result.summary
        metadata = result.metadata or {}
        answer = result.answer
        approval_message = metadata.get("approval_message", "")

        estimated_size = self._estimate_size_fast(pure_data)
        if (
            (result.tool_name or context.tool_name) in self._SOURCE_READ_TOOL_NAMES
            and metadata.get("file_path")
        ):
            self._record_materialization(result, context, estimated_size, used_artifact=False)
            return self._format_source_read_reference(
                result=result,
                summary=summary,
                metadata=metadata,
                answer=answer,
                approval_message=approval_message,
                estimated_size=estimated_size,
            )

        # 记录物化
        self._record_materialization(result, context, estimated_size, used_artifact=True)

        # 保存到文件
        if isinstance(pure_data, str):
            artifact = context.artifact_store.save_text(
                session_id=context.session_id,
                tool_name=result.tool_name or context.tool_name,
                content=pure_data,
                suffix=".txt",
                ttl_seconds=context.artifact_ttl_seconds,
            )
        else:
            artifact = context.artifact_store.save_json(
                session_id=context.session_id,
                tool_name=result.tool_name or context.tool_name,
                data=pure_data,
                ttl_seconds=context.artifact_ttl_seconds,
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
            parts.append(f"📝 样本: {sample_str}")

        # 自动生成数据结构预览（仅对 dict/list 类型）
        if isinstance(pure_data, (dict, list)):
            try:
                from tools.document_executor import _preview_data_value
                structure = _preview_data_value(
                    pure_data,
                    max_depth=2,
                    max_fields=10,
                    sample_size=3,
                )
                structure_str = json.dumps(structure, ensure_ascii=False, indent=2)
                if len(structure_str) > 1500:
                    structure_str = structure_str[:1500] + "\n  ..."
                parts.append(f"🔍 数据结构:\n```json\n{structure_str}\n```")
            except Exception:
                pass  # 预览失败不影响主流程

        return "\n".join(parts)

    def _format_source_read_reference(
        self,
        *,
        result: "ToolExecutionResult",
        summary: str,
        metadata: dict,
        answer: str | None,
        approval_message: str,
        estimated_size: int,
    ) -> str:
        """Avoid re-materializing already-read files into a second temp file."""
        file_path = str(metadata.get("file_path") or "")
        preview_limit = 500
        content = result.content if isinstance(result.content, str) else str(result.content)
        preview = content[:preview_limit]
        if len(content) > preview_limit:
            preview = preview.rstrip() + "..."

        parts = []
        if answer:
            parts.append(f"✅ {answer}\n")
        elif summary:
            parts.append(f"✅ {summary}\n")
        if approval_message:
            parts.append(f"👤 用户批注: {approval_message}\n")

        parts.append(f"📄 原始文件: {file_path}")

        if result.tool_name == "read_file":
            start_line = metadata.get("start_line")
            end_line = metadata.get("end_line")
            if start_line is not None and end_line is not None:
                parts.append(f"📍 当前片段: 行 {start_line}-{end_line}")
            if metadata.get("has_more"):
                next_offset = metadata.get("next_offset")
                parts.append(f"💡 如需后续内容，请继续调用 read_file(file_path='{file_path}', offset={next_offset})")
        else:
            file_type = metadata.get("file_type")
            char_count = metadata.get("char_count")
            meta_parts = []
            if file_type:
                meta_parts.append(f"类型: {file_type}")
            if char_count:
                meta_parts.append(f"字符数: {char_count}")
            if estimated_size:
                meta_parts.append(f"估算大小: {estimated_size}")
            if meta_parts:
                parts.append(f"📊 {' | '.join(meta_parts)}")
            parts.append("💡 后续步骤优先直接使用原始 file_path，避免把读取结果再次落盘")

        if preview:
            parts.append(f"📝 预览: {preview}")

        return "\n".join(parts)
