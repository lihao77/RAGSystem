# -*- coding: utf-8 -*-
"""Helpers for tool/agent result placeholder resolution."""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from typing import Any

from .result_schema import ToolExecutionResult


def materialize_result_reference(result: Any) -> Any:
    """
    Convert heterogeneous results into a placeholder-friendly reference object.
    """
    if isinstance(result, ToolExecutionResult):
        error_message = result.content if not result.success else None
        reference = {
            "success": result.success,
            "tool_name": result.tool_name,
            "summary": result.summary,
            "answer": result.answer,
            "output_type": result.output_type,
            "content": result.content,
            "metadata": result.metadata,
            "artifacts": [materialize_result_reference(item) for item in result.artifacts],
        }
        if error_message is not None:
            reference["error"] = str(error_message)
        return reference

    if is_dataclass(result):
        return asdict(result)

    raise TypeError(
        f"result_references 仅接受 ToolExecutionResult，收到: {type(result).__name__}"
    )


def result_success(result: Any) -> bool:
    """Return success flag for heterogeneous results."""
    reference = materialize_result_reference(result)
    if isinstance(reference, dict):
        return reference.get("success", True) is not False
    return True


def result_error_message(result: Any) -> str:
    """Extract a human-readable error message from heterogeneous results."""
    reference = materialize_result_reference(result)
    if isinstance(reference, dict):
        error = reference.get("error")
        if error:
            return str(error)
        if reference.get("success") is False:
            return str(reference.get("content") or reference.get("summary") or "未知错误")
    return "未知错误"


def result_metadata(result: Any) -> dict[str, Any]:
    """Extract metadata dict from heterogeneous results."""
    reference = materialize_result_reference(result)
    if not isinstance(reference, dict):
        return {}

    metadata = reference.get("metadata")
    if isinstance(metadata, dict):
        return metadata

    return {}


def result_summary(result: Any) -> str:
    """Extract summary text from heterogeneous results."""
    reference = materialize_result_reference(result)
    if not isinstance(reference, dict):
        return ""

    summary = reference.get("summary")
    if summary:
        return str(summary)

    return ""


def result_primary_content(result: Any) -> Any:
    """Return the primary payload that should be chained into downstream calls."""
    reference = materialize_result_reference(result)
    if isinstance(reference, dict):
        if "content" in reference:
            return reference.get("content")
    return reference


def resolve_result_path(result: Any, json_path: str | None) -> Any:
    """Resolve a dotted placeholder path against a heterogeneous result."""
    value = materialize_result_reference(result)
    if not json_path:
        return value

    for key in json_path.split('.'):
        if isinstance(value, dict):
            value = value.get(key)
        elif isinstance(value, list):
            try:
                value = value[int(key)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return value


def stringify_result_value(value: Any) -> str:
    """Serialize a placeholder value into text suitable for prompt injection."""
    if isinstance(value, str):
        return value
    return json.dumps(_clean_value(value), ensure_ascii=False)


def result_primary_text(result: Any) -> str:
    """Return primary content as text without changing success semantics."""
    primary = result_primary_content(result)
    if primary is None:
        return ""
    return stringify_result_value(primary)


def result_display_text(result: Any) -> str:
    """Return a display-friendly text for logs/events/UI."""
    if not result_success(result):
        return result_error_message(result)

    primary_text = result_primary_text(result)
    if primary_text:
        return primary_text

    return result_summary(result)


def result_event_payload(result: Any) -> Any:
    """Return a JSON-serializable payload for tool/agent events."""
    reference = materialize_result_reference(result)
    return _clean_value(reference)


def result_visualization_payload(result: Any) -> dict[str, Any] | None:
    """Extract chart/map payload from heterogeneous results."""
    primary = result_primary_content(result)
    if isinstance(primary, dict):
        return primary
    return None


def _clean_value(value: Any) -> Any:
    """Recursively clean values for JSON serialization."""
    import math

    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, dict):
        return {key: _clean_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_clean_value(item) for item in value]
    return value
