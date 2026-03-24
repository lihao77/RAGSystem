# -*- coding: utf-8 -*-
"""可视化 artifact 持久化、读取、修改管理器。"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict

from agents.artifacts import ArtifactStore
from tools.contracts.result_models import ArtifactRef
from tools.paths.path_resolution import SESSIONS_ROOT, get_session_visualizations_root

logger = logging.getLogger(__name__)
_INDEX_FILE = 'viz_index.jsonl'


@dataclass
class VisualizationRecord:
    artifact_id: str
    viz_type: str
    sub_type: str
    title: str
    version: int
    artifact_ref: ArtifactRef
    session_id: str | None
    created_at: float
    updated_at: float


@dataclass
class _IndexEntry:
    artifact_id: str
    viz_type: str
    sub_type: str
    title: str
    version: int
    file_path: str
    artifact_type: str
    mime_type: str | None
    session_id: str | None
    created_at: float
    updated_at: float


class VisualizationArtifactManager:
    """持久化、读取、修改可视化 artifact。"""

    def __init__(self, artifact_store: ArtifactStore | None = None):
        self._artifact_store = artifact_store or ArtifactStore()
        self._lock = threading.RLock()
        self._records: dict[str, VisualizationRecord] = {}
        self._session_index: dict[str, set[str]] = {}
        self._restore_from_index()

    def create_chart(
        self,
        *,
        session_id: str | None,
        chart_config: Dict[str, Any],
        chart_type: str,
        title: str = '',
    ) -> VisualizationRecord:
        artifact_id = f'viz_{uuid.uuid4().hex[:10]}'
        payload = {
            'artifact_id': artifact_id,
            'viz_type': 'chart',
            'sub_type': chart_type,
            'title': title,
            'version': 1,
            'config': chart_config,
        }
        ref = self._artifact_store.save_json(
            session_id=session_id,
            tool_name='create_chart',
            data=payload,
            metadata={'artifact_id': artifact_id, 'storage_scope': 'visualizations'},
        )
        record = self._make_record(
            artifact_id=artifact_id,
            viz_type='chart',
            sub_type=chart_type,
            title=title,
            version=1,
            artifact_ref=ref,
            session_id=session_id,
        )
        self._register(record)
        return record

    def create_map(
        self,
        *,
        session_id: str | None,
        map_data: Dict[str, Any],
        map_type: str,
        title: str = '',
    ) -> VisualizationRecord:
        artifact_id = f'viz_{uuid.uuid4().hex[:10]}'
        payload = {
            'artifact_id': artifact_id,
            'viz_type': 'map',
            'sub_type': map_type,
            'title': title,
            'version': 1,
            'config': map_data,
        }
        ref = self._artifact_store.save_json(
            session_id=session_id,
            tool_name='create_map',
            data=payload,
            metadata={'artifact_id': artifact_id, 'storage_scope': 'visualizations'},
        )
        record = self._make_record(
            artifact_id=artifact_id,
            viz_type='map',
            sub_type=map_type,
            title=title,
            version=1,
            artifact_ref=ref,
            session_id=session_id,
        )
        self._register(record)
        return record

    def create_image(
        self,
        *,
        session_id: str | None,
        image_path: str,
        title: str = '',
    ) -> VisualizationRecord:
        artifact_id = f'viz_{uuid.uuid4().hex[:10]}'
        ref = ArtifactRef(
            artifact_type='image',
            path=image_path,
            mime_type='image/png',
            size=None,
            metadata={'artifact_id': artifact_id},
        )
        record = self._make_record(
            artifact_id=artifact_id,
            viz_type='image',
            sub_type='png',
            title=title,
            version=1,
            artifact_ref=ref,
            session_id=session_id,
        )
        self._register(record)
        return record

    def revise(
        self,
        artifact_id: str,
        config_patch: Dict[str, Any],
        replace: bool = False,
    ) -> VisualizationRecord:
        record = self.get_record(artifact_id)
        if record.viz_type == 'image':
            raise ValueError('图片类型的 artifact 不支持修改配置')

        current = self._read_json(record.artifact_ref.path)
        current_config = current.get('config', {})
        new_config = config_patch if replace else self._deep_merge(current_config, config_patch)

        current['config'] = new_config
        current['version'] = record.version + 1
        self._write_json(record.artifact_ref.path, current)

        with self._lock:
            record.version += 1
            record.updated_at = time.time()
        self._rewrite_session_index(record.session_id)
        return record

    def get_record(self, artifact_id: str) -> VisualizationRecord:
        with self._lock:
            record = self._records.get(artifact_id)
        if record is None:
            raise KeyError(f'未找到可视化 artifact: {artifact_id}')
        return record

    def get_config(self, artifact_id: str) -> dict:
        record = self.get_record(artifact_id)
        if record.viz_type == 'image':
            return {
                'artifact_id': record.artifact_id,
                'viz_type': 'image',
                'sub_type': 'png',
                'title': record.title,
                'version': record.version,
                'image_url': record.artifact_ref.path,
            }
        return self._read_json(record.artifact_ref.path)

    def list_by_session(self, session_id: str) -> list[VisualizationRecord]:
        with self._lock:
            ids = self._session_index.get(session_id, set())
            return [self._records[aid] for aid in ids if aid in self._records]

    def delete_by_session(self, session_id: str) -> int:
        with self._lock:
            ids = self._session_index.pop(session_id, set())
            if not ids:
                return 0
            removed = []
            for aid in ids:
                record = self._records.pop(aid, None)
                if record:
                    removed.append(record)

        for record in removed:
            self._delete_file(record.artifact_ref.path)
        self._delete_index_file(session_id)
        logger.info('已清理 session=%s 的 %d 个可视化 artifact', session_id, len(removed))
        return len(removed)

    def delete_record(self, artifact_id: str) -> bool:
        with self._lock:
            record = self._records.pop(artifact_id, None)
            if not record:
                return False
            sid = record.session_id
            if sid and sid in self._session_index:
                self._session_index[sid].discard(artifact_id)
                if not self._session_index[sid]:
                    del self._session_index[sid]

        self._delete_file(record.artifact_ref.path)
        self._rewrite_session_index(record.session_id)
        return True

    def _make_record(
        self,
        *,
        artifact_id: str,
        viz_type: str,
        sub_type: str,
        title: str,
        version: int,
        artifact_ref: ArtifactRef,
        session_id: str | None,
    ) -> VisualizationRecord:
        now = time.time()
        return VisualizationRecord(
            artifact_id=artifact_id,
            viz_type=viz_type,
            sub_type=sub_type,
            title=title,
            version=version,
            artifact_ref=artifact_ref,
            session_id=session_id,
            created_at=now,
            updated_at=now,
        )

    def _register(self, record: VisualizationRecord) -> None:
        with self._lock:
            self._records[record.artifact_id] = record
            if record.session_id:
                self._session_index.setdefault(record.session_id, set()).add(record.artifact_id)
        self._append_index_entry(record)

    def _session_index_path(self, session_id: str | None) -> Path | None:
        if not session_id:
            return None
        return get_session_visualizations_root(session_id) / _INDEX_FILE

    def _append_index_entry(self, record: VisualizationRecord) -> None:
        index_path = self._session_index_path(record.session_id)
        if index_path is None:
            return
        entry = _IndexEntry(
            artifact_id=record.artifact_id,
            viz_type=record.viz_type,
            sub_type=record.sub_type,
            title=record.title,
            version=record.version,
            file_path=record.artifact_ref.path,
            artifact_type=record.artifact_ref.artifact_type,
            mime_type=record.artifact_ref.mime_type,
            session_id=record.session_id,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )
        index_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(index_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(asdict(entry), ensure_ascii=False) + '\n')
        except Exception:
            logger.warning('追加 viz 索引失败', exc_info=True)

    def _rewrite_session_index(self, session_id: str | None) -> None:
        index_path = self._session_index_path(session_id)
        if index_path is None:
            return
        with self._lock:
            ids = list(self._session_index.get(session_id or '', set())) if session_id else []
            records = [self._records[aid] for aid in ids if aid in self._records]
        if not records:
            if index_path.exists():
                index_path.unlink()
            return
        index_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(index_path, 'w', encoding='utf-8') as f:
                for r in records:
                    entry = _IndexEntry(
                        artifact_id=r.artifact_id,
                        viz_type=r.viz_type,
                        sub_type=r.sub_type,
                        title=r.title,
                        version=r.version,
                        file_path=r.artifact_ref.path,
                        artifact_type=r.artifact_ref.artifact_type,
                        mime_type=r.artifact_ref.mime_type,
                        session_id=r.session_id,
                        created_at=r.created_at,
                        updated_at=r.updated_at,
                    )
                    f.write(json.dumps(asdict(entry), ensure_ascii=False) + '\n')
        except Exception:
            logger.warning('重写 viz 索引失败', exc_info=True)

    def _delete_index_file(self, session_id: str | None) -> None:
        index_path = self._session_index_path(session_id)
        if index_path and index_path.exists():
            try:
                index_path.unlink()
            except Exception:
                logger.warning('删除 viz 索引失败: %s', index_path, exc_info=True)

    def _restore_from_index(self) -> None:
        restored = 0
        skipped = 0
        for index_path in SESSIONS_ROOT.glob(f'*/visualizations/{_INDEX_FILE}'):
            try:
                with open(index_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            skipped += 1
                            continue
                        if not isinstance(data, dict):
                            skipped += 1
                            continue
                        file_path = data.get('file_path', '')
                        if not file_path or not os.path.exists(file_path):
                            skipped += 1
                            continue
                        artifact_id = data.get('artifact_id', '')
                        if not artifact_id:
                            skipped += 1
                            continue
                        ref = ArtifactRef(
                            artifact_type=data.get('artifact_type', 'json'),
                            path=file_path,
                            mime_type=data.get('mime_type'),
                            size=None,
                            metadata={'artifact_id': artifact_id},
                        )
                        record = VisualizationRecord(
                            artifact_id=artifact_id,
                            viz_type=data.get('viz_type', 'chart'),
                            sub_type=data.get('sub_type', ''),
                            title=data.get('title', ''),
                            version=data.get('version', 1),
                            artifact_ref=ref,
                            session_id=data.get('session_id'),
                            created_at=data.get('created_at', 0.0),
                            updated_at=data.get('updated_at', 0.0),
                        )
                        self._records[artifact_id] = record
                        sid = record.session_id
                        if sid:
                            self._session_index.setdefault(sid, set()).add(artifact_id)
                        restored += 1
            except Exception:
                logger.warning('恢复 viz 索引失败: %s', index_path, exc_info=True)

        if restored > 0 or skipped > 0:
            logger.info('viz 索引恢复完成：restored=%d, skipped=%d, sessions=%d', restored, skipped, len(self._session_index))

    @staticmethod
    def _read_json(path: str) -> dict:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)

    @staticmethod
    def _write_json(path: str, data: dict) -> None:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    @staticmethod
    def _delete_file(path: str) -> None:
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception:
            logger.warning('删除文件失败: %s', path, exc_info=True)

    @staticmethod
    def _deep_merge(current: Any, patch: Any) -> Any:
        if not isinstance(current, dict) or not isinstance(patch, dict):
            return patch
        merged = dict(current)
        for key, value in patch.items():
            merged[key] = VisualizationArtifactManager._deep_merge(merged.get(key), value)
        return merged


_manager: VisualizationArtifactManager | None = None
_manager_lock = threading.Lock()


def get_visualization_artifact_manager() -> VisualizationArtifactManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = VisualizationArtifactManager()
    return _manager
