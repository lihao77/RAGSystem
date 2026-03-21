# -*- coding: utf-8 -*-
"""
会话调试日志文件写入器。

将消息与运行步骤额外镜像到 JSONL 文件，方便人工排查模型行为。
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


class SessionTraceWriter:
    """将会话消息与运行步骤镜像到 JSONL 文件。"""

    def __init__(self, base_dir: Optional[str | Path] = None, enabled: Optional[bool] = None):
        if enabled is None:
            enabled = os.getenv('SESSION_TRACE_ENABLED', 'true').lower() not in ('0', 'false', 'no')
        self.enabled = enabled

        if base_dir is None:
            base_dir = os.getenv('SESSION_TRACE_DIR')
        if base_dir is None:
            from tools.path_resolution import SESSION_TRACES_ROOT
            base_dir = SESSION_TRACES_ROOT

        self.base_dir = Path(base_dir)
        self._lock = threading.RLock()
        if self.enabled:
            self.base_dir.mkdir(parents=True, exist_ok=True)

    def append_message(
        self,
        *,
        session_id: str,
        run_id: str,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
        message_id: Optional[str] = None,
        seq: Optional[int] = None,
        source: str = 'message',
    ) -> None:
        if not self.enabled:
            return
        record = {
            'timestamp': self._now_iso(),
            'kind': 'message',
            'source': source,
            'session_id': session_id,
            'run_id': run_id,
            'message_id': message_id,
            'seq': seq,
            'role': role,
            'content': content,
            'metadata': metadata or {},
        }
        self._append_jsonl(self._session_dir(session_id) / 'messages.jsonl', record)

    def append_run_step(
        self,
        *,
        session_id: str,
        run_id: str,
        step_type: str,
        payload: Dict[str, Any],
    ) -> None:
        if not self.enabled:
            return
        record = {
            'timestamp': self._now_iso(),
            'kind': 'run_step',
            'session_id': session_id,
            'run_id': run_id,
            'step_type': step_type,
            'payload': payload,
        }
        self._append_jsonl(self._run_dir(session_id, run_id) / 'steps.jsonl', record)

    def _append_jsonl(self, path: Path, record: Dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False)
        with self._lock:
            with open(path, 'a', encoding='utf-8') as handle:
                handle.write(line + '\n')

    def _session_dir(self, session_id: str) -> Path:
        return self.base_dir / session_id

    def _run_dir(self, session_id: str, run_id: str) -> Path:
        return self._session_dir(session_id) / 'runs' / run_id

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()
