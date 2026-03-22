# -*- coding: utf-8 -*-
"""Prompt materialization for normalized tool observations."""

from __future__ import annotations

from copy import deepcopy

from agents.artifacts import ArtifactStore
from agents.monitoring.observation_window import ObservationWindowCollector
from tools.result_schema import ToolExecutionResult

from .observation_formatters import (
    BaseObservationFormatter,
    FormatContext,
    ObservationFormatterRegistry,
    get_default_registry,
)
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
        self._registry = registry or deepcopy(get_default_registry())

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

        context = FormatContext(
            tool_name=tool_name or result.tool_name,
            session_id=session_id,
            is_skills_tool=is_skills_tool,
            mode=decision.mode,
            artifact_store=self.artifact_store,
            observation_window=self.observation_window,
            large_data_threshold=self.large_data_threshold,
            artifact_ttl_seconds=decision.artifact_ttl_seconds,
        )

        return self._registry.format(result, context)

    def register_formatter(self, formatter: BaseObservationFormatter) -> None:
        """Register a custom formatter used by the materializer."""
        self._registry.register(formatter)

    def list_formatters(self) -> list[str]:
        """List registered formatter names."""
        return self._registry.list_formatters()
