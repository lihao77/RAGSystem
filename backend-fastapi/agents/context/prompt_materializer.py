# -*- coding: utf-8 -*-
"""Prompt materialization for normalized tool observations."""

from __future__ import annotations

import json

from agents.artifacts import ArtifactStore
from agents.monitoring.observation_window import ObservationWindowCollector
from tools.result_schema import ToolExecutionResult

from .observation_formatters import (
    BaseObservationFormatter,
    FormatContext,
    ObservationFormatterRegistry,
    get_default_registry,
)
from .observation_formatters.large_payload import LargePayloadFormatter
from .observation_policy import ObservationDecision


class PromptMaterializer:
    """Render policy decisions into LLM-facing observation text."""

    def __init__(
        self,
        *,
        artifact_store: ArtifactStore | None = None,
        observation_window: ObservationWindowCollector | None = None,
        registry: ObservationFormatterRegistry | None = None,
        large_data_threshold: int = 8000,
    ):
        self.artifact_store = artifact_store or ArtifactStore()
        self.observation_window = observation_window
        self.large_data_threshold = large_data_threshold
        self._registry = registry or get_default_registry()
        self._large_payload_formatter = LargePayloadFormatter()

    def materialize_tool_observation(
        self,
        result: ToolExecutionResult,
        decision: ObservationDecision,
        *,
        tool_name: str = "",
        is_skills_tool: bool = False,
        session_id: str | None = None,
    ) -> str:
        if decision.mode == "drop":
            return ""

        if not result.success:
            return f"❌ 错误: {result.content or '未知错误'}"

        context = FormatContext(
            tool_name=tool_name or result.tool_name,
            session_id=session_id,
            is_skills_tool=is_skills_tool,
            no_truncate=decision.mode != "artifact_ref",
            artifact_store=self.artifact_store,
            observation_window=self.observation_window,
            large_data_threshold=self.large_data_threshold,
            snippet_limit=decision.snippet_limit,
            artifact_ttl_seconds=decision.artifact_ttl_seconds,
        )

        if decision.mode == "artifact_ref":
            return self._large_payload_formatter.format(result, context)

        if decision.mode == "summarize":
            return self._materialize_summary(result, context)

        return self._registry.format(result, context)

    def register_formatter(self, formatter: BaseObservationFormatter) -> None:
        """Register a custom formatter used by the materializer."""
        self._registry.register(formatter)

    def list_formatters(self) -> list[str]:
        """List registered formatter names."""
        return self._registry.list_formatters()

    def _materialize_summary(self, result: ToolExecutionResult, context: FormatContext) -> str:
        estimated_size = self._large_payload_formatter._estimate_size_fast(result.content)
        self._record_materialization(
            tool_name=result.tool_name or context.tool_name,
            output_type=result.output_type,
            estimated_size=estimated_size,
            threshold=context.large_data_threshold,
            used_artifact=False,
        )

        prefix = self._build_prefix(result)
        if result.output_type == "json" or isinstance(result.content, (dict, list)):
            content = json.dumps(result.content, ensure_ascii=False, indent=2)
            snippet = self._truncate(content, context.snippet_limit)
            label = "📊 数据详情:\n" if result.answer else ""
            return f"{prefix}{label}```json\n{snippet}\n```\n（内容已按上下文预算截断）"

        content = result.content if isinstance(result.content, str) else str(result.content)
        snippet = self._truncate(content, context.snippet_limit)
        return f"{prefix}{snippet}\n\n（内容已按上下文预算截断）"

    def _build_prefix(self, result: ToolExecutionResult) -> str:
        metadata = result.metadata or {}
        approval_message = metadata.get("approval_message", "")
        if result.answer:
            prefix = f"✅ {result.answer}\n\n"
        else:
            prefix = f"✅ {result.summary}\n\n" if result.summary else "✅ 执行成功\n\n"
        if approval_message:
            prefix += f"👤 用户批注: {approval_message}\n\n"
        return prefix

    @staticmethod
    def _truncate(content: str, limit: int) -> str:
        if len(content) <= limit:
            return content
        return content[:limit] + "..."

    def _record_materialization(
        self,
        *,
        tool_name: str,
        output_type: str,
        estimated_size: int,
        threshold: int,
        used_artifact: bool,
    ) -> None:
        if self.observation_window is None:
            return
        self.observation_window.record_materialization(
            tool_name=tool_name,
            output_type=output_type,
            estimated_size=estimated_size,
            threshold=threshold,
            used_artifact=used_artifact,
        )
