# -*- coding: utf-8 -*-
"""Tool observation formatting helpers."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from agents.artifacts import ArtifactStore
from agents.monitoring.observation_window import ObservationWindowCollector
from tools.result_normalizer import ToolResultNormalizer
from tools.result_schema import ToolExecutionResult


class ObservationFormatter:
    """
    Format tool responses into compact observations for the next LLM turn.
    """

    LARGE_DATA_THRESHOLD = 8000
    SUMMARY_MAX_LENGTH = 300

    def __init__(
        self,
        data_save_dir: str = "./static/temp_data",
        artifact_store: ArtifactStore | None = None,
        result_normalizer: ToolResultNormalizer | None = None,
        observation_window: ObservationWindowCollector | None = None,
    ):
        self.data_save_dir = data_save_dir
        self.observation_window = observation_window or ObservationWindowCollector()
        self.artifact_store = artifact_store or ArtifactStore(
            base_dir=data_save_dir,
            observation_window=self.observation_window,
        )
        self.result_normalizer = result_normalizer or ToolResultNormalizer(
            observation_window=self.observation_window,
        )
        self.logger = logging.getLogger(f"{__name__}.ObservationFormatter")

    def format(
        self,
        result: Any,
        tool_name: str = None,
        is_skills_tool: bool = False,
        no_truncate: bool = False,
    ) -> str:
        del no_truncate

        normalized = self.result_normalizer.normalize(result, tool_name=tool_name)
        if not normalized.success:
            return f"❌ 错误: {normalized.content or '未知错误'}"

        if is_skills_tool:
            self._record_materialization(result=normalized, estimated_size=self._estimate_size_fast(normalized.content), used_artifact=False)
            return self._format_skills_result(normalized)

        if normalized.metadata.get("source_shape") == "primitive":
            self._record_materialization(result=normalized, estimated_size=self._estimate_size_fast(normalized.content), used_artifact=False)
            return str(normalized.content)

        return self._format_standard_response(normalized)

    def _format_skills_result(self, result: ToolExecutionResult) -> str:
        pure_data = result.content
        summary = result.summary
        data: Dict[str, Any] = {"results": pure_data}
        if result.metadata:
            data["metadata"] = result.metadata
        if summary:
            data["summary"] = summary
        if result.answer:
            data["answer"] = result.answer

        if isinstance(pure_data, dict):
            skill_content = pure_data.get("main_content") or pure_data.get("content")
            if skill_content:
                return f"✅ {summary}\n\n{skill_content}" if summary else skill_content

        return json.dumps(data, ensure_ascii=False, indent=2)

    def _estimate_size_fast(self, data: Any) -> int:
        if isinstance(data, str):
            return len(data)

        if isinstance(data, list):
            if len(data) == 0:
                return 2
            if len(data) <= 10:
                return len(json.dumps(data, ensure_ascii=False))

            sample = data[:10]
            sample_size = len(json.dumps(sample, ensure_ascii=False))
            return int(sample_size * (len(data) / len(sample)))

        if isinstance(data, dict):
            if len(data) == 0:
                return 2
            if len(data) <= 10:
                return len(json.dumps(data, ensure_ascii=False))

            sample = dict(list(data.items())[:10])
            sample_size = len(json.dumps(sample, ensure_ascii=False))
            return int(sample_size * (len(data) / len(sample)))

        return len(str(data))

    def _format_standard_response(self, result: ToolExecutionResult) -> str:
        pure_data = result.content
        summary = result.summary
        metadata = result.metadata or {}
        answer = result.answer
        approval_message = metadata.get("approval_message", "")

        estimated_size = self._estimate_size_fast(pure_data)
        self.logger.debug(
            "数据大小估算: %s 字符（阈值: %s）",
            estimated_size,
            self.LARGE_DATA_THRESHOLD,
        )

        if isinstance(pure_data, str):
            prefix = f"✅ {summary}\n\n" if summary else "✅ 执行成功\n\n"
            if approval_message:
                prefix += f"👤 用户批注: {approval_message}\n\n"
            self._record_materialization(result=result, estimated_size=estimated_size, used_artifact=False)
            return f"{prefix}{pure_data}"

        if estimated_size < self.LARGE_DATA_THRESHOLD:
            content_str = (
                json.dumps(pure_data, ensure_ascii=False)
                if isinstance(pure_data, (dict, list))
                else str(pure_data)
            )

            if answer:
                prefix = f"✅ {answer}\n\n"
                if approval_message:
                    prefix += f"👤 用户批注: {approval_message}\n\n"
                self._record_materialization(result=result, estimated_size=estimated_size, used_artifact=False)
                return f"{prefix}📊 数据详情:\n```json\n{content_str[:2000]}\n```"

            prefix = f"✅ {summary}\n\n" if summary else "✅ 执行成功\n\n"
            if approval_message:
                prefix += f"👤 用户批注: {approval_message}\n\n"
            self._record_materialization(result=result, estimated_size=estimated_size, used_artifact=False)
            return f"{prefix}```json\n{content_str}\n```"

        self._record_materialization(result=result, estimated_size=estimated_size, used_artifact=True)
        artifact = self.artifact_store.save_json(
            session_id=None,
            tool_name=result.tool_name,
            data=pure_data,
        )
        result.artifacts.append(artifact)

        meta_info_parts = []
        if summary:
            meta_info_parts.append(summary)

        if metadata:
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

        parts = []
        if answer:
            parts.append(f"✅ {answer}\n")
        if approval_message:
            parts.append(f"👤 用户批注: {approval_message}\n")

        parts.append(f"📁 数据已存储: {artifact.path}")
        parts.append(f"📊 {meta_info}")
        parts.append("💡 后续工具可直接使用此文件路径作为参数")

        if metadata.get("sample"):
            sample = metadata["sample"]
            sample_str = json.dumps(sample, ensure_ascii=False)
            if len(sample_str) > 200:
                sample_str = sample_str[:200] + "..."
            parts.append(f"📝 样本: {sample_str}")

        return "\n".join(parts)

    def _record_materialization(
        self,
        *,
        result: ToolExecutionResult,
        estimated_size: int,
        used_artifact: bool,
    ) -> None:
        self.observation_window.record_materialization(
            tool_name=result.tool_name,
            output_type=result.output_type,
            estimated_size=estimated_size,
            threshold=self.LARGE_DATA_THRESHOLD,
            used_artifact=used_artifact,
        )
