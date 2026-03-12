# -*- coding: utf-8 -*-
"""Managed visualization candidate store for delayed frontend presentation."""

from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from agents.artifacts import ArtifactStore
from tools.result_schema import ArtifactRef


@dataclass
class PresentationCandidate:
    candidate_id: str
    kind: str
    status: str
    version: int
    config_artifact: ArtifactRef
    preview: Dict[str, Any] = field(default_factory=dict)
    source_tool: str = ""
    source_call_id: Optional[str] = None
    session_id: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)


class PresentationStore:
    """Persist and track visualization drafts until an agent explicitly presents them."""

    def __init__(self, artifact_store: ArtifactStore | None = None):
        self._artifact_store = artifact_store or ArtifactStore()
        self._lock = threading.RLock()
        self._candidates: dict[str, PresentationCandidate] = {}

    def create_chart_candidate(
        self,
        *,
        session_id: str | None,
        chart_config: Dict[str, Any],
        chart_type: str,
        source_tool: str = "generate_chart",
        source_call_id: str | None = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> PresentationCandidate:
        artifact = self._artifact_store.save_json(
            session_id=session_id,
            tool_name=source_tool,
            data=chart_config,
        )
        candidate_id = f"chart_{uuid.uuid4().hex[:10]}"
        preview = self._build_chart_preview(chart_config, chart_type)
        now = time.time()
        candidate = PresentationCandidate(
            candidate_id=candidate_id,
            kind="chart",
            status="draft",
            version=1,
            config_artifact=artifact,
            preview=preview,
            source_tool=source_tool,
            source_call_id=source_call_id,
            session_id=session_id,
            created_at=now,
            updated_at=now,
            metadata={
                "chart_type": chart_type,
                **(metadata or {}),
            },
        )
        with self._lock:
            self._candidates[candidate_id] = candidate
        return candidate

    def get_candidate(self, candidate_id: str, *, session_id: str | None = None) -> PresentationCandidate:
        with self._lock:
            candidate = self._candidates.get(candidate_id)
        if candidate is None:
            raise KeyError(f"未找到可视化候选: {candidate_id}")
        self._ensure_session(candidate, session_id=session_id)
        return candidate

    def read_candidate_config(self, candidate_id: str, *, session_id: str | None = None) -> Dict[str, Any]:
        candidate = self.get_candidate(candidate_id, session_id=session_id)
        with open(candidate.config_artifact.path, "r", encoding="utf-8") as file_obj:
            payload = json.load(file_obj)
        if not isinstance(payload, dict):
            raise ValueError(f"候选配置格式无效: {candidate_id}")
        return payload

    def update_chart_candidate(
        self,
        candidate_id: str,
        *,
        config_patch: Dict[str, Any],
        session_id: str | None = None,
        replace: bool = False,
    ) -> PresentationCandidate:
        candidate = self.get_candidate(candidate_id, session_id=session_id)
        current_config = self.read_candidate_config(candidate_id, session_id=session_id)
        next_config = config_patch if replace else self._deep_merge(current_config, config_patch)
        self._validate_chart_config(next_config)

        with open(candidate.config_artifact.path, "w", encoding="utf-8") as file_obj:
            json.dump(next_config, file_obj, ensure_ascii=False, indent=2)

        chart_type = self._extract_chart_type(next_config, fallback=candidate.metadata.get("chart_type", "bar"))
        with self._lock:
            candidate.version += 1
            candidate.status = "revised"
            candidate.preview = self._build_chart_preview(next_config, chart_type)
            candidate.updated_at = time.time()
            candidate.metadata["chart_type"] = chart_type
        return candidate

    def select_chart_candidate(
        self,
        candidate_id: str,
        *,
        session_id: str | None = None,
    ) -> tuple[PresentationCandidate, Dict[str, Any], str]:
        candidate = self.get_candidate(candidate_id, session_id=session_id)
        chart_config = self.read_candidate_config(candidate_id, session_id=session_id)
        self._validate_chart_config(chart_config)
        chart_type = self._extract_chart_type(chart_config, fallback=candidate.metadata.get("chart_type", "bar"))

        with self._lock:
            candidate.status = "selected"
            candidate.updated_at = time.time()
            candidate.metadata["chart_type"] = chart_type
            candidate.preview = self._build_chart_preview(chart_config, chart_type)

        return candidate, chart_config, chart_type

    def mark_published(self, candidate_id: str, *, session_id: str | None = None) -> PresentationCandidate:
        candidate = self.get_candidate(candidate_id, session_id=session_id)
        with self._lock:
            candidate.status = "published"
            candidate.updated_at = time.time()
        return candidate

    def _ensure_session(self, candidate: PresentationCandidate, *, session_id: str | None) -> None:
        if session_id and candidate.session_id and candidate.session_id != session_id:
            raise PermissionError(f"候选 {candidate.candidate_id} 不属于当前会话")

    def _validate_chart_config(self, config: Dict[str, Any]) -> None:
        if not isinstance(config, dict):
            raise ValueError("图表配置必须是对象")
        if "series" not in config:
            raise ValueError("图表配置缺少 series 字段")
        if not isinstance(config.get("series"), list) or not config["series"]:
            raise ValueError("图表配置的 series 必须是非空列表")

    def _build_chart_preview(self, chart_config: Dict[str, Any], chart_type: str) -> Dict[str, Any]:
        title = ""
        title_block = chart_config.get("title")
        if isinstance(title_block, dict):
            title = str(title_block.get("text") or "")

        series = chart_config.get("series") or []
        series_names = []
        if isinstance(series, list):
            for item in series[:5]:
                if isinstance(item, dict):
                    series_names.append(str(item.get("name") or item.get("type") or chart_type))

        dataset = chart_config.get("dataset") or {}
        dataset_rows = 0
        if isinstance(dataset, dict):
            source = dataset.get("source")
            if isinstance(source, list):
                dataset_rows = len(source)

        return {
            "title": title or "未命名图表",
            "chart_type": chart_type,
            "series_count": len(series) if isinstance(series, list) else 0,
            "series_names": series_names,
            "dataset_rows": dataset_rows,
        }

    def _extract_chart_type(self, chart_config: Dict[str, Any], *, fallback: str = "bar") -> str:
        series = chart_config.get("series")
        if isinstance(series, list):
            for item in series:
                if isinstance(item, dict) and item.get("type"):
                    return str(item["type"])
        return fallback

    def _deep_merge(self, current: Any, patch: Any) -> Any:
        if not isinstance(current, dict) or not isinstance(patch, dict):
            return patch

        merged = dict(current)
        for key, value in patch.items():
            merged[key] = self._deep_merge(merged.get(key), value)
        return merged


_presentation_store: PresentationStore | None = None
_store_lock = threading.Lock()


def get_presentation_store() -> PresentationStore:
    global _presentation_store
    with _store_lock:
        if _presentation_store is None:
            _presentation_store = PresentationStore()
    return _presentation_store
