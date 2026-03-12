# -*- coding: utf-8 -*-
"""Artifact persistence for tool observations."""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

from agents.monitoring.observation_window import ObservationWindowCollector
from tools.result_schema import ArtifactRef


class ArtifactStore:
    """Persist large tool outputs using the shared temp-data artifact path contract."""

    def __init__(
        self,
        base_dir: str = "./static/temp_data",
        observation_window: ObservationWindowCollector | None = None,
    ):
        self.base_dir = base_dir
        self.observation_window = observation_window

    def save_json(self, *, session_id: str | None, tool_name: str, data: Any) -> ArtifactRef:
        del session_id

        file_path = self._allocate_path(suffix=".json")
        with open(file_path, "w", encoding="utf-8") as file_obj:
            json.dump(data, file_obj, ensure_ascii=False, indent=2)

        artifact = ArtifactRef(
            artifact_type="json",
            path=file_path,
            mime_type="application/json",
            size=os.path.getsize(file_path),
        )
        self._record_artifact(tool_name=tool_name, artifact=artifact)
        return artifact

    def save_text(
        self,
        *,
        session_id: str | None,
        tool_name: str,
        content: str,
        suffix: str = ".json",
    ) -> ArtifactRef:
        del session_id

        file_path = self._allocate_path(suffix=suffix)
        with open(file_path, "w", encoding="utf-8") as file_obj:
            file_obj.write(content)

        artifact = ArtifactRef(
            artifact_type="text",
            path=file_path,
            mime_type="text/plain",
            size=os.path.getsize(file_path),
        )
        self._record_artifact(tool_name=tool_name, artifact=artifact)
        return artifact

    def cleanup(self, max_age_seconds: int) -> int:
        target_dir = Path(self.base_dir)
        if not target_dir.exists():
            return 0

        cutoff_time = time.time() - max_age_seconds
        deleted_count = 0

        for file_path in target_dir.glob("data_*.*"):
            try:
                if file_path.stat().st_mtime < cutoff_time:
                    file_path.unlink()
                    deleted_count += 1
            except FileNotFoundError:
                continue

        return deleted_count

    def _allocate_path(self, *, suffix: str) -> str:
        os.makedirs(self.base_dir, exist_ok=True)
        file_name = f"data_{uuid.uuid4().hex[:8]}{suffix}"
        return os.path.join(self.base_dir, file_name)

    def _record_artifact(self, *, tool_name: str, artifact: ArtifactRef) -> None:
        if self.observation_window is None:
            return
        self.observation_window.record_artifact_saved(
            tool_name=tool_name,
            artifact_type=artifact.artifact_type,
            size=artifact.size or 0,
        )
