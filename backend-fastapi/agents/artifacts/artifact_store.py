# -*- coding: utf-8 -*-
"""Artifact persistence for tool observations."""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from agents.monitoring.observation_window import ObservationWindowCollector
from tools.contracts.result_models import ArtifactRef


@dataclass
class ArtifactRecord:
    artifact_type: str
    path: str
    tool_name: str
    session_id: str | None
    created_at: float
    expires_at: float | None = None
    mime_type: str | None = None
    size: int | None = None
    metadata: dict[str, Any] | None = None


class ArtifactStore:
    """Persist large tool outputs using session-aware managed directories."""

    def __init__(
        self,
        base_dir: str | None = None,
        index_file: str | None = None,
        observation_window: ObservationWindowCollector | None = None,
    ):
        from core.path_resolution import get_session_transient_root

        self.base_dir = str(Path(base_dir).resolve()) if base_dir else str(get_session_transient_root("anonymous"))
        self._uses_default_base_dir = base_dir is None
        self.index_file = index_file
        self.observation_window = observation_window
        self._lock = threading.RLock()

    def save_json(
        self,
        *,
        session_id: str | None,
        tool_name: str,
        data: Any,
        metadata: dict[str, Any] | None = None,
        ttl_seconds: int | None = None,
    ) -> ArtifactRef:
        file_path, index_path = self._allocate_paths(
            session_id=session_id,
            tool_name=tool_name,
            metadata=metadata,
            suffix='.json',
        )
        with open(file_path, 'w', encoding='utf-8') as file_obj:
            json.dump(data, file_obj, ensure_ascii=False, indent=2)

        artifact = ArtifactRef(
            artifact_type='json',
            path=file_path,
            mime_type='application/json',
            size=os.path.getsize(file_path),
            metadata=self._build_artifact_metadata(
                session_id=session_id,
                tool_name=tool_name,
                ttl_seconds=ttl_seconds,
                extra=metadata,
            ),
        )
        self._record_artifact(
            session_id=session_id,
            tool_name=tool_name,
            artifact=artifact,
            ttl_seconds=ttl_seconds,
            index_file=index_path,
        )
        return artifact

    def save_text(
        self,
        *,
        session_id: str | None,
        tool_name: str,
        content: str,
        suffix: str = '.json',
        metadata: dict[str, Any] | None = None,
        ttl_seconds: int | None = None,
    ) -> ArtifactRef:
        file_path, index_path = self._allocate_paths(
            session_id=session_id,
            tool_name=tool_name,
            metadata=metadata,
            suffix=suffix,
        )
        with open(file_path, 'w', encoding='utf-8') as file_obj:
            file_obj.write(content)

        artifact = ArtifactRef(
            artifact_type='text',
            path=file_path,
            mime_type='text/plain',
            size=os.path.getsize(file_path),
            metadata=self._build_artifact_metadata(
                session_id=session_id,
                tool_name=tool_name,
                ttl_seconds=ttl_seconds,
                extra=metadata,
            ),
        )
        self._record_artifact(
            session_id=session_id,
            tool_name=tool_name,
            artifact=artifact,
            ttl_seconds=ttl_seconds,
            index_file=index_path,
        )
        return artifact

    def cleanup(self, max_age_seconds: int) -> int:
        from core.path_resolution import SESSIONS_ROOT

        target_dir = Path(self.base_dir).resolve() if self.base_dir else SESSIONS_ROOT.resolve()
        cutoff_time = time.time() - max_age_seconds
        deleted_paths: set[str] = set()

        with self._lock:
            deleted_indexed_paths, indexed_paths = self._cleanup_indexed_artifacts(cutoff_time)
            deleted_paths.update(deleted_indexed_paths)
            deleted_paths.update(self._cleanup_legacy_files(target_dir, cutoff_time, indexed_paths))

        return len(deleted_paths)

    def list_records(self, *, session_id: str | None = None) -> list[ArtifactRecord]:
        records = self._read_index_records(session_id=session_id)
        if session_id is None:
            return records
        return [record for record in records if record.session_id == session_id]

    def _allocate_paths(
        self,
        *,
        session_id: str | None,
        tool_name: str,
        metadata: dict[str, Any] | None,
        suffix: str,
    ) -> tuple[str, str]:
        root = self._resolve_storage_root(session_id=session_id, tool_name=tool_name, metadata=metadata)
        root.mkdir(parents=True, exist_ok=True)
        file_name = f'data_{uuid.uuid4().hex[:8]}{suffix}'
        return str(root / file_name), str(root / 'artifact_index.jsonl')

    def _resolve_storage_root(
        self,
        *,
        session_id: str | None,
        tool_name: str,
        metadata: dict[str, Any] | None,
    ) -> Path:
        from core.path_resolution import (
            get_session_transient_root,
            get_session_visualizations_root,
            SESSIONS_ROOT,
        )

        if self.base_dir and not self._uses_default_base_dir:
            return Path(self.base_dir).resolve()

        if metadata and metadata.get('storage_scope') == 'visualizations':
            if not session_id:
                raise ValueError('visualizations artifact 缺少 session_id')
            return get_session_visualizations_root(session_id)

        if session_id:
            return get_session_transient_root(session_id)

        return (SESSIONS_ROOT / 'anonymous' / 'transient').resolve()

    def _record_artifact(
        self,
        *,
        session_id: str | None,
        tool_name: str,
        artifact: ArtifactRef,
        ttl_seconds: int | None,
        index_file: str,
    ) -> None:
        created_at = float(artifact.metadata.get('created_at', time.time()))
        expires_at = artifact.metadata.get('expires_at')
        record = ArtifactRecord(
            artifact_type=artifact.artifact_type,
            path=artifact.path,
            tool_name=tool_name,
            session_id=session_id,
            created_at=created_at,
            expires_at=float(expires_at) if expires_at is not None else None,
            mime_type=artifact.mime_type,
            size=artifact.size,
            metadata={
                key: value
                for key, value in artifact.metadata.items()
                if key not in {'session_id', 'tool_name', 'created_at', 'expires_at'}
            },
        )
        self._append_index_record(record, index_file=index_file)

        if self.observation_window is None:
            return
        self.observation_window.record_artifact_saved(
            tool_name=tool_name,
            artifact_type=artifact.artifact_type,
            size=artifact.size or 0,
        )

    def _build_artifact_metadata(
        self,
        *,
        session_id: str | None,
        tool_name: str,
        ttl_seconds: int | None,
        extra: dict[str, Any] | None,
    ) -> dict[str, Any]:
        created_at = time.time()
        metadata = {
            'session_id': session_id,
            'tool_name': tool_name,
            'created_at': created_at,
        }
        if ttl_seconds is not None:
            metadata['expires_at'] = created_at + ttl_seconds
        if extra:
            metadata.update(extra)
        return metadata

    def _append_index_record(self, record: ArtifactRecord, *, index_file: str) -> None:
        index_path = Path(index_file)
        index_path.parent.mkdir(parents=True, exist_ok=True)
        with open(index_path, 'a', encoding='utf-8') as file_obj:
            file_obj.write(json.dumps(asdict(record), ensure_ascii=False) + '\n')

    def _index_files(self, *, session_id: str | None = None) -> list[Path]:
        from core.path_resolution import SESSIONS_ROOT

        if self.index_file:
            return [Path(self.index_file)]
        if self.base_dir and not self._uses_default_base_dir:
            return [Path(self.base_dir) / 'artifact_index.jsonl']
        if session_id:
            return [
                Path(self._resolve_storage_root(session_id=session_id, tool_name='artifact', metadata=None)) / 'artifact_index.jsonl',
                Path(self._resolve_storage_root(session_id=session_id, tool_name='artifact', metadata={'storage_scope': 'visualizations'})) / 'artifact_index.jsonl',
            ]
        return list(SESSIONS_ROOT.glob('*/**/artifact_index.jsonl'))

    def _read_index_records(self, *, session_id: str | None = None) -> list[ArtifactRecord]:
        records: list[ArtifactRecord] = []
        for index_path in self._index_files(session_id=session_id):
            if not index_path.exists():
                continue
            with open(index_path, 'r', encoding='utf-8') as file_obj:
                for line in file_obj:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(payload, dict):
                        continue
                    try:
                        records.append(ArtifactRecord(**payload))
                    except TypeError:
                        continue
        return records

    def _write_index_records(self, records: list[ArtifactRecord], *, index_file: Path) -> None:
        if not records:
            if index_file.exists():
                index_file.unlink()
            return

        index_file.parent.mkdir(parents=True, exist_ok=True)
        with open(index_file, 'w', encoding='utf-8') as file_obj:
            for record in records:
                file_obj.write(json.dumps(asdict(record), ensure_ascii=False) + '\n')

    def _cleanup_indexed_artifacts(self, cutoff_time: float) -> tuple[set[str], set[str]]:
        deleted_paths: set[str] = set()
        indexed_paths: set[str] = set()

        for index_path in self._index_files():
            records: list[ArtifactRecord] = []
            if index_path.exists():
                with open(index_path, 'r', encoding='utf-8') as file_obj:
                    for line in file_obj:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            payload = json.loads(line)
                            record = ArtifactRecord(**payload)
                        except Exception:
                            continue
                        indexed_paths.add(record.path)
                        if self._should_preserve_record(record):
                            records.append(record)
                            continue
                        path = Path(record.path)
                        expired = self._is_record_expired(record, cutoff_time)
                        if expired:
                            if path.exists():
                                try:
                                    path.unlink()
                                except FileNotFoundError:
                                    pass
                                else:
                                    deleted_paths.add(str(path))
                            continue
                        records.append(record)
            self._write_index_records(records, index_file=index_path)

        return deleted_paths, indexed_paths

    def _cleanup_legacy_files(
        self,
        target_dir: Path,
        cutoff_time: float,
        indexed_paths: set[str],
    ) -> set[str]:
        deleted_paths: set[str] = set()
        if not target_dir.exists():
            return deleted_paths

        for file_path in target_dir.glob('**/data_*.*'):
            if str(file_path) in indexed_paths:
                continue
            if self._is_visualization_path(file_path):
                continue
            if str(file_path) in deleted_paths:
                continue
            try:
                if file_path.stat().st_mtime < cutoff_time:
                    file_path.unlink()
                    deleted_paths.add(str(file_path))
            except FileNotFoundError:
                continue
        return deleted_paths

    def _should_preserve_record(self, record: ArtifactRecord) -> bool:
        metadata = record.metadata or {}
        if metadata.get('storage_scope') == 'visualizations':
            return True
        return self._is_visualization_path(Path(record.path))

    @staticmethod
    def _is_visualization_path(path: Path) -> bool:
        return 'visualizations' in {part.lower() for part in path.parts}

    def _is_record_expired(self, record: ArtifactRecord, cutoff_time: float) -> bool:
        try:
            file_mtime = Path(record.path).stat().st_mtime
        except FileNotFoundError:
            return True

        if record.expires_at is not None:
            return record.expires_at <= time.time()

        if record.created_at < cutoff_time:
            return True

        return file_mtime < cutoff_time
