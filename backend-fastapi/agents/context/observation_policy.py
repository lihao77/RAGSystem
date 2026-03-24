# -*- coding: utf-8 -*-
"""Observation policy for tool-result materialization decisions."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from tools.contracts.result_models import ToolExecutionResult

_GEOJSON_TYPES = {"FeatureCollection", "Feature", "Point", "MultiPoint",
                  "LineString", "MultiLineString", "Polygon", "MultiPolygon",
                  "GeometryCollection"}


def _is_geojson_like(data: dict) -> bool:
    """Quick check whether a dict looks like GeoJSON."""
    return data.get("type") in _GEOJSON_TYPES


def _estimate_size_fast(data: Any) -> int:
    """Fast approximate character-size estimator."""
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


@dataclass
class ObservationDecision:
    mode: str
    reason: str = ""
    estimated_size: int = 0
    artifact_ttl_seconds: int | None = None
    budget_bucket: str = "balanced"


@dataclass(frozen=True)
class ObservationBudget:
    bucket_name: str
    inline_text_limit: int
    inline_json_limit: int
    summarize_limit: int
    artifact_ttl_seconds: int


class ObservationPolicy:
    """Budget-aware observation materialization policy."""

    def __init__(
        self,
        *,
        max_context_tokens: int = 8000,
        budget_profile: str = "worker",
        inline_text_limit: int | None = None,
        inline_json_limit: int | None = None,
        summarize_limit: int | None = None,
        artifact_ttl_seconds: int | None = None,
    ):
        self.max_context_tokens = max_context_tokens
        self.budget_profile = budget_profile
        budget = self._build_budget(
            max_context_tokens=max_context_tokens,
            budget_profile=budget_profile,
            inline_text_limit=inline_text_limit,
            inline_json_limit=inline_json_limit,
            summarize_limit=summarize_limit,
            artifact_ttl_seconds=artifact_ttl_seconds,
        )
        self.inline_text_limit = budget.inline_text_limit
        self.inline_json_limit = budget.inline_json_limit
        self.summarize_limit = budget.summarize_limit
        self.artifact_ttl_seconds = budget.artifact_ttl_seconds
        self.budget_bucket = budget.bucket_name
        self.large_data_threshold = self.summarize_limit

    def decide(
        self,
        result: ToolExecutionResult,
        *,
        is_skills_tool: bool = False,
    ) -> ObservationDecision:
        estimated_size = _estimate_size_fast(result.content)

        # 1. 强制落盘
        if result.metadata.get("force_artifact"):
            return ObservationDecision(
                mode="artifact_ref",
                reason="force_artifact",
                estimated_size=estimated_size,
                artifact_ttl_seconds=self.artifact_ttl_seconds,
                budget_bucket=self.budget_bucket,
            )

        # 2. 错误始终 inline
        if not result.success:
            return ObservationDecision(
                mode="inline",
                reason="error_inline",
                estimated_size=estimated_size,
                budget_bucket=self.budget_bucket,
            )

        # 3. chart/map 始终 inline（artifact_id 驱动，数据量小）
        if result.output_type in {"chart", "map"}:
            return ObservationDecision(
                mode="inline",
                reason="visualization_inline",
                estimated_size=estimated_size,
                budget_bucket=self.budget_bucket,
            )

        # 4. Skills 文档类工具始终 inline（激活文档需完整注入上下文）
        _SKILLS_DOC_TOOLS = {"activate_skill", "load_skill_resource", "get_skill_info"}
        if is_skills_tool and result.tool_name in _SKILLS_DOC_TOOLS:
            return ObservationDecision(
                mode="inline",
                reason="skills_inline",
                estimated_size=estimated_size,
                budget_bucket=self.budget_bucket,
            )

        # 4.5 read_file 始终 inline（不落盘，大文件已有用户确认机制把关）
        if result.tool_name == "read_file":
            reason = "user_approved_read" if result.metadata.get("user_approved_full_read") else "read_file_inline"
            return ObservationDecision(
                mode="inline",
                reason=reason,
                estimated_size=estimated_size,
                budget_bucket=self.budget_bucket,
            )

        # 5. 两阶段决策：inline 或 artifact_ref（不再有 summarize 中间态）
        inline_limit = self._inline_limit_for(result)

        if estimated_size <= inline_limit:
            return ObservationDecision(
                mode="inline",
                reason="size_inline",
                estimated_size=estimated_size,
                budget_bucket=self.budget_bucket,
            )

        return ObservationDecision(
            mode="artifact_ref",
            reason="large_payload",
            estimated_size=estimated_size,
            artifact_ttl_seconds=self.artifact_ttl_seconds,
            budget_bucket=self.budget_bucket,
        )

    def _inline_limit_for(self, result: ToolExecutionResult) -> int:
        if result.output_type == "text" or isinstance(result.content, str):
            return self.inline_text_limit
        # GeoJSON 内容 inline 阈值降低（coordinates 占大量 token）
        if isinstance(result.content, dict) and _is_geojson_like(result.content):
            return int(self.inline_json_limit * 0.4)
        return self.inline_json_limit

    @staticmethod
    def _build_budget(
        *,
        max_context_tokens: int,
        budget_profile: str,
        inline_text_limit: int | None,
        inline_json_limit: int | None,
        summarize_limit: int | None,
        artifact_ttl_seconds: int | None,
    ) -> ObservationBudget:
        if max_context_tokens <= 8000:
            budget = ObservationBudget(
                bucket_name="compact",
                inline_text_limit=800,
                inline_json_limit=1200,
                summarize_limit=4000,
                artifact_ttl_seconds=6 * 60 * 60,
            )
        elif max_context_tokens <= 32000:
            budget = ObservationBudget(
                bucket_name="balanced",
                inline_text_limit=1600,
                inline_json_limit=2400,
                summarize_limit=9000,
                artifact_ttl_seconds=12 * 60 * 60,
            )
        else:
            budget = ObservationBudget(
                bucket_name="expansive",
                inline_text_limit=2600,
                inline_json_limit=3600,
                summarize_limit=16000,
                artifact_ttl_seconds=24 * 60 * 60,
            )

        if budget_profile == "orchestrator":
            budget = ObservationBudget(
                bucket_name=budget.bucket_name,
                inline_text_limit=int(budget.inline_text_limit * 0.85),
                inline_json_limit=int(budget.inline_json_limit * 0.85),
                summarize_limit=int(budget.summarize_limit * 0.85),
                artifact_ttl_seconds=max(2 * 60 * 60, int(budget.artifact_ttl_seconds * 0.75)),
            )

        return ObservationBudget(
            bucket_name=budget.bucket_name,
            inline_text_limit=inline_text_limit or budget.inline_text_limit,
            inline_json_limit=inline_json_limit or budget.inline_json_limit,
            summarize_limit=summarize_limit or budget.summarize_limit,
            artifact_ttl_seconds=artifact_ttl_seconds or budget.artifact_ttl_seconds,
        )
