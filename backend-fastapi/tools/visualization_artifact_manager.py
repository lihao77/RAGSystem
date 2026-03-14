# -*- coding: utf-8 -*-
"""可视化 artifact 持久化、读取、修改管理器。"""

from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from agents.artifacts import ArtifactStore
from tools.result_schema import ArtifactRef


@dataclass
class VisualizationRecord:
    artifact_id: str              # "viz_abc123"
    viz_type: str                 # "chart" | "map" | "image"
    sub_type: str                 # chart_type 或 map_type
    title: str
    version: int
    artifact_ref: ArtifactRef     # 指向 ./static/temp_data/viz_xxx.json
    session_id: str | None
    created_at: float
    updated_at: float


class VisualizationArtifactManager:
    """持久化、读取、修改可视化 artifact。"""

    def __init__(self, artifact_store: ArtifactStore | None = None):
        self._artifact_store = artifact_store or ArtifactStore()
        self._lock = threading.RLock()
        self._records: dict[str, VisualizationRecord] = {}

    # ── 创建 ─────────────────────────────────────────────────

    def create_chart(
        self,
        *,
        session_id: str | None,
        chart_config: Dict[str, Any],
        chart_type: str,
        title: str = "",
    ) -> VisualizationRecord:
        artifact_id = f"viz_{uuid.uuid4().hex[:10]}"
        payload = {
            "artifact_id": artifact_id,
            "viz_type": "chart",
            "sub_type": chart_type,
            "title": title,
            "version": 1,
            "config": chart_config,
        }
        ref = self._artifact_store.save_json(
            session_id=session_id,
            tool_name="create_chart",
            data=payload,
            metadata={"artifact_id": artifact_id},
        )
        now = time.time()
        record = VisualizationRecord(
            artifact_id=artifact_id,
            viz_type="chart",
            sub_type=chart_type,
            title=title,
            version=1,
            artifact_ref=ref,
            session_id=session_id,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._records[artifact_id] = record
        return record

    def create_map(
        self,
        *,
        session_id: str | None,
        map_data: Dict[str, Any],
        map_type: str,
        title: str = "",
    ) -> VisualizationRecord:
        artifact_id = f"viz_{uuid.uuid4().hex[:10]}"
        payload = {
            "artifact_id": artifact_id,
            "viz_type": "map",
            "sub_type": map_type,
            "title": title,
            "version": 1,
            "config": map_data,
        }
        ref = self._artifact_store.save_json(
            session_id=session_id,
            tool_name="create_map",
            data=payload,
            metadata={"artifact_id": artifact_id},
        )
        now = time.time()
        record = VisualizationRecord(
            artifact_id=artifact_id,
            viz_type="map",
            sub_type=map_type,
            title=title,
            version=1,
            artifact_ref=ref,
            session_id=session_id,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._records[artifact_id] = record
        return record

    def create_image(
        self,
        *,
        session_id: str | None,
        image_path: str,
        title: str = "",
    ) -> VisualizationRecord:
        """为 matplotlib 兜底生成的 PNG 创建记录。"""
        artifact_id = f"viz_{uuid.uuid4().hex[:10]}"
        ref = ArtifactRef(
            artifact_type="image",
            path=image_path,
            mime_type="image/png",
            size=None,
            metadata={"artifact_id": artifact_id},
        )
        now = time.time()
        record = VisualizationRecord(
            artifact_id=artifact_id,
            viz_type="image",
            sub_type="png",
            title=title,
            version=1,
            artifact_ref=ref,
            session_id=session_id,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._records[artifact_id] = record
        return record

    # ── 修改 ─────────────────────────────────────────────────

    def revise(
        self,
        artifact_id: str,
        config_patch: Dict[str, Any],
        replace: bool = False,
    ) -> VisualizationRecord:
        record = self.get_record(artifact_id)
        if record.viz_type == "image":
            raise ValueError("图片类型的 artifact 不支持修改配置")

        current = self._read_json(record.artifact_ref.path)
        current_config = current.get("config", {})
        new_config = config_patch if replace else self._deep_merge(current_config, config_patch)

        current["config"] = new_config
        current["version"] = record.version + 1
        self._write_json(record.artifact_ref.path, current)

        with self._lock:
            record.version += 1
            record.updated_at = time.time()
        return record

    # ── 读取 ─────────────────────────────────────────────────

    def get_record(self, artifact_id: str) -> VisualizationRecord:
        with self._lock:
            record = self._records.get(artifact_id)
        if record is None:
            raise KeyError(f"未找到可视化 artifact: {artifact_id}")
        return record

    def get_config(self, artifact_id: str) -> dict:
        """REST API 用：返回持久化 JSON 的完整内容。"""
        record = self.get_record(artifact_id)
        if record.viz_type == "image":
            return {
                "artifact_id": record.artifact_id,
                "viz_type": "image",
                "sub_type": "png",
                "title": record.title,
                "version": record.version,
                "image_url": record.artifact_ref.path,
            }
        return self._read_json(record.artifact_ref.path)

    def list_by_session(self, session_id: str) -> list[VisualizationRecord]:
        with self._lock:
            return [
                r for r in self._records.values()
                if r.session_id == session_id
            ]

    # ── 内部工具 ──────────────────────────────────────────────

    @staticmethod
    def _read_json(path: str) -> dict:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def _write_json(path: str, data: dict) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    @staticmethod
    def _deep_merge(current: Any, patch: Any) -> Any:
        if not isinstance(current, dict) or not isinstance(patch, dict):
            return patch
        merged = dict(current)
        for key, value in patch.items():
            merged[key] = VisualizationArtifactManager._deep_merge(merged.get(key), value)
        return merged


# ── 单例 ─────────────────────────────────────────────────────

_manager: VisualizationArtifactManager | None = None
_manager_lock = threading.Lock()


def get_visualization_artifact_manager() -> VisualizationArtifactManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = VisualizationArtifactManager()
    return _manager
