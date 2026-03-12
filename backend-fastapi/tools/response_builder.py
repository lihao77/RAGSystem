# -*- coding: utf-8 -*-
"""Canonical builders for ToolExecutionResult."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .result_schema import ArtifactRef, ToolExecutionResult


def success_result(
    content: Any,
    *,
    summary: str = "",
    answer: Optional[str] = None,
    output_type: str = "text",
    metadata: Optional[Dict[str, Any]] = None,
    tool_name: str = "",
    artifacts: Optional[List[ArtifactRef]] = None,
    llm_hint: Optional[str] = None,
) -> ToolExecutionResult:
    """Build a successful ToolExecutionResult."""
    return ToolExecutionResult(
        success=True,
        tool_name=tool_name,
        summary=summary,
        answer=answer,
        output_type=output_type,
        content=content,
        metadata=metadata or {},
        artifacts=artifacts or [],
        llm_hint=llm_hint,
    )


def error_result(
    message: str,
    *,
    tool_name: str = "",
    metadata: Optional[Dict[str, Any]] = None,
) -> ToolExecutionResult:
    """Build an error ToolExecutionResult."""
    meta = metadata or {}
    meta["source_shape"] = "error"
    return ToolExecutionResult(
        success=False,
        tool_name=tool_name,
        summary=message,
        content=message,
        output_type="error",
        metadata=meta,
        artifacts=[],
        llm_hint=None,
    )
