# -*- coding: utf-8 -*-
"""Normalize heterogeneous tool outputs into ToolExecutionResult."""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from agents.monitoring.observation_window import ObservationWindowCollector

from .result_schema import ToolExecutionResult


TOOL_OUTPUT_TYPE_MAP = {
    "generate_chart": "chart",
    "generate_map": "map",
    "activate_skill": "markdown",
    "load_skill_resource": "markdown",
    "execute_skill_script": "text",
    "read_document": "text",
    "chunk_document": "json",
    "extract_structured_data": "json",
    "merge_extracted_data": "json",
    "write_file": "text",
    "read_file": "text",
}


class ToolResultNormalizer:
    """Normalize current tool result variants without changing tool implementations."""

    _DOCUMENT_NORMALIZERS: Dict[str, str] = {
        "read_document": "_normalize_document_result",
        "chunk_document": "_normalize_document_chunk_result",
        "extract_structured_data": "_normalize_document_extract_result",
        "merge_extracted_data": "_normalize_document_merge_result",
    }

    def __init__(self, observation_window: ObservationWindowCollector | None = None):
        self.observation_window = observation_window

    def normalize(self, raw_result: Any, tool_name: Optional[str] = None) -> ToolExecutionResult:
        if isinstance(raw_result, ToolExecutionResult):
            return raw_result

        resolved_tool_name = tool_name or ""
        if not isinstance(raw_result, dict):
            normalized = ToolExecutionResult(
                success=True,
                tool_name=resolved_tool_name,
                content=raw_result,
                output_type=self._infer_output_type(resolved_tool_name, raw_result, success=True),
                metadata={"source_shape": "primitive"},
                llm_hint=None,
            )
            self._record_normalization(
                tool_name=resolved_tool_name,
                output_type=normalized.output_type,
                branch="primitive",
                success=True,
            )
            return normalized

        if raw_result.get("success") is False:
            error_message = raw_result.get("error") or raw_result.get("message") or "未知错误"
            normalized = ToolExecutionResult(
                success=False,
                tool_name=resolved_tool_name,
                content=error_message,
                output_type="error",
                metadata={"source_shape": "error"},
                llm_hint=None,
            )
            self._record_normalization(
                tool_name=resolved_tool_name,
                output_type=normalized.output_type,
                branch="error",
                success=False,
            )
            return normalized

        normalizer, branch = self._resolve_normalizer(resolved_tool_name, raw_result)
        normalized = normalizer(raw_result, resolved_tool_name)

        approval_message = raw_result.get("approval_message")
        if approval_message:
            normalized.metadata.setdefault("approval_message", approval_message)

        normalized.output_type = self._infer_output_type(
            resolved_tool_name,
            normalized.content,
            success=normalized.success,
            explicit=normalized.output_type,
        )
        normalized.llm_hint = None
        self._record_normalization(
            tool_name=resolved_tool_name,
            output_type=normalized.output_type,
            branch=branch,
            success=normalized.success,
        )
        return normalized

    def _resolve_normalizer(
        self,
        tool_name: str,
        raw_result: Dict[str, Any],
    ) -> tuple[Callable[[Dict[str, Any], str], ToolExecutionResult], str]:
        document_normalizer_name = self._DOCUMENT_NORMALIZERS.get(tool_name)
        if document_normalizer_name:
            return getattr(self, document_normalizer_name), document_normalizer_name

        if isinstance(raw_result.get("data"), dict):
            return self._normalize_standard_result, "standard_result"

        if any(key in raw_result for key in ("content", "chunks", "results", "data")):
            return self._normalize_direct_result, "direct_result"

        return self._normalize_generic_result, "generic_result"

    def _normalize_standard_result(
        self,
        raw_result: Dict[str, Any],
        tool_name: str,
    ) -> ToolExecutionResult:
        data = raw_result.get("data") or {}
        summary = data.get("summary", "")
        answer = data.get("answer")
        metadata = data.get("metadata", {}) if isinstance(data.get("metadata"), dict) else {}
        content = data.get("results")
        if content is None:
            content = {
                key: value
                for key, value in data.items()
                if key not in {"summary", "metadata", "answer", "debug"}
            }
            if not content:
                content = data

        return ToolExecutionResult(
            success=True,
            tool_name=tool_name,
            summary=summary,
            answer=answer,
            output_type="text",
            content=content,
            metadata=metadata,
            llm_hint=None,
        )

    def _normalize_direct_result(
        self,
        raw_result: Dict[str, Any],
        tool_name: str,
    ) -> ToolExecutionResult:
        metadata = raw_result.get("metadata", {}) if isinstance(raw_result.get("metadata"), dict) else {}
        summary = raw_result.get("summary", "")
        answer = raw_result.get("answer")

        if "content" in raw_result:
            content = raw_result.get("content")
        elif "chunks" in raw_result:
            content = raw_result.get("chunks")
        elif "results" in raw_result:
            content = raw_result.get("results")
        else:
            content = raw_result.get("data")

        if content is None:
            content = {
                key: value
                for key, value in raw_result.items()
                if key not in {"success", "summary", "metadata", "answer", "approval_message"}
            }

        return ToolExecutionResult(
            success=True,
            tool_name=tool_name,
            summary=summary,
            answer=answer,
            output_type="text",
            content=content,
            metadata=metadata,
            llm_hint=None,
        )

    def _normalize_generic_result(
        self,
        raw_result: Dict[str, Any],
        tool_name: str,
    ) -> ToolExecutionResult:
        content = {
            key: value
            for key, value in raw_result.items()
            if key not in {"success", "approval_message"}
        }
        return ToolExecutionResult(
            success=True,
            tool_name=tool_name,
            output_type="text",
            content=content,
            metadata={"source_shape": "generic_dict"},
            llm_hint=None,
        )

    def _normalize_document_result(
        self,
        raw_result: Dict[str, Any],
        tool_name: str,
    ) -> ToolExecutionResult:
        file_path = raw_result.get("file_path", "")
        file_type = raw_result.get("file_type", "document")
        char_count = raw_result.get("char_count")
        summary = f"文档读取成功: {file_path}" if file_path else "文档读取成功"
        if char_count is not None:
            summary += f"（{char_count} 字符）"

        metadata = {
            key: value
            for key, value in raw_result.items()
            if key not in {"success", "content"}
        }
        metadata.setdefault("file_type", file_type)

        return ToolExecutionResult(
            success=True,
            tool_name=tool_name,
            summary=summary,
            output_type="text",
            content=raw_result.get("content", ""),
            metadata=metadata,
            llm_hint=None,
        )

    def _normalize_document_chunk_result(
        self,
        raw_result: Dict[str, Any],
        tool_name: str,
    ) -> ToolExecutionResult:
        total_chunks = raw_result.get("total_chunks", 0)
        strategy = raw_result.get("strategy", "fixed")
        metadata = {
            key: value
            for key, value in raw_result.items()
            if key not in {"success", "chunks"}
        }

        return ToolExecutionResult(
            success=True,
            tool_name=tool_name,
            summary=f"文档分块成功: 共 {total_chunks} 块（{strategy}）",
            output_type="json",
            content=raw_result.get("chunks", []),
            metadata=metadata,
            llm_hint=None,
        )

    def _normalize_document_extract_result(
        self,
        raw_result: Dict[str, Any],
        tool_name: str,
    ) -> ToolExecutionResult:
        text_length = raw_result.get("text_length")
        summary = "结构化提取成功"
        if text_length is not None:
            summary += f"（源文本 {text_length} 字符）"

        metadata = {
            key: value
            for key, value in raw_result.items()
            if key not in {"success", "data"}
        }

        return ToolExecutionResult(
            success=True,
            tool_name=tool_name,
            summary=summary,
            output_type="json",
            content=raw_result.get("data"),
            metadata=metadata,
            llm_hint=None,
        )

    def _normalize_document_merge_result(
        self,
        raw_result: Dict[str, Any],
        tool_name: str,
    ) -> ToolExecutionResult:
        total_items = raw_result.get("total_items")
        merge_strategy = raw_result.get("merge_strategy", "append")
        summary = f"提取结果合并成功（{merge_strategy}）"
        if total_items is not None:
            summary += f"，共 {total_items} 项"

        metadata = {
            key: value
            for key, value in raw_result.items()
            if key not in {"success", "data"}
        }

        return ToolExecutionResult(
            success=True,
            tool_name=tool_name,
            summary=summary,
            output_type="json",
            content=raw_result.get("data"),
            metadata=metadata,
            llm_hint=None,
        )

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
    ) -> None:
        if self.observation_window is None:
            return
        self.observation_window.record_normalization(
            tool_name=tool_name,
            output_type=output_type,
            branch=branch,
            success=success,
        )
