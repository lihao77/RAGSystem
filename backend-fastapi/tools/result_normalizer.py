# -*- coding: utf-8 -*-
"""Normalize ToolExecutionResult outputs for downstream formatting."""

from __future__ import annotations

from typing import Any, Optional

from agents.monitoring.observation_window import ObservationWindowCollector

from .result_schema import ToolExecutionResult


TOOL_OUTPUT_TYPE_MAP = {
    "generate_chart": "chart",
    "update_chart_config": "chart",
    "present_chart": "chart",
    "generate_map": "map",
    "activate_skill": "markdown",
    "load_skill_resource": "markdown",
    "execute_skill_script": "text",
    "get_skill_info": "json",
    "read_document": "text",
    "chunk_document": "json",
    "extract_structured_data": "json",
    "merge_extracted_data": "json",
    "write_file": "text",
    "read_file": "text",
}


class ToolResultNormalizer:
    """Strict normalizer that only accepts ToolExecutionResult."""

    def __init__(self, observation_window: ObservationWindowCollector | None = None):
        self.observation_window = observation_window

    def normalize(self, raw_result: Any, tool_name: Optional[str] = None) -> ToolExecutionResult:
        """Return a normalized ToolExecutionResult or fail fast for non-standard payloads."""
        if not isinstance(raw_result, ToolExecutionResult):
            raise TypeError(
                f"ToolResultNormalizer 仅接受 ToolExecutionResult，收到: {type(raw_result).__name__}"
            )

        if not raw_result.tool_name and tool_name:
            raw_result.tool_name = tool_name
        resolved_tool_name = raw_result.tool_name or tool_name or ""
        raw_result.output_type = self._infer_output_type(
            resolved_tool_name,
            raw_result.content,
            success=raw_result.success,
            explicit=raw_result.output_type,
        )
        self._record_normalization(
            tool_name=resolved_tool_name,
            output_type=raw_result.output_type,
            branch="direct_passthrough",
            success=raw_result.success,
            native=True,
        )
        return raw_result

    def _infer_output_type(
        self,
        tool_name: str,
        content: Any,
        *,
        success: bool,
        explicit: Optional[str] = None,
    ) -> str:
        if not success:
            return "error"

        if explicit and explicit != "text":
            return explicit

        mapped_type = TOOL_OUTPUT_TYPE_MAP.get(tool_name)
        if mapped_type:
            return mapped_type

        if isinstance(content, str):
            return "text"
        if isinstance(content, (dict, list)):
            return "json"
        return explicit or "text"

    def _record_normalization(
        self,
        *,
        tool_name: str,
        output_type: str,
        branch: str,
        success: bool,
        native: bool,
    ) -> None:
        if self.observation_window is None:
            return
        self.observation_window.record_normalization(
            tool_name=tool_name,
            output_type=output_type,
            branch=branch,
            success=success,
            native=native,
        )
