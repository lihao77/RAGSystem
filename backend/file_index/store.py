# -*- coding: utf-8 -*-
"""本地文件索引（YAML）"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
import uuid

from utils.yaml_store import load_yaml_file, save_yaml_file


class FileIndex:
    def __init__(self, index_path: str | None = None):
        if index_path is None:
            index_path = Path(__file__).parent / "files.yaml"
        self.index_path = Path(index_path)
        self.index_path.parent.mkdir(parents=True, exist_ok=True)

    def list(self) -> List[Dict[str, Any]]:
        data = self._read()
        items = list(data.values())
        items.sort(key=lambda x: x.get('uploaded_at', ''), reverse=True)
        return items

    def get(self, file_id: str) -> Optional[Dict[str, Any]]:
        return self._read().get(file_id)

    def add(self, *,
            original_name: str,
            stored_name: str,
            stored_path: str,
            size: int = 0,
            mime: str = "") -> Dict[str, Any]:
        data = self._read()
        file_id = str(uuid.uuid4())[:10]
        now = datetime.now().isoformat()
        rec = {
            "id": file_id,
            "original_name": original_name,
            "stored_name": stored_name,
            "stored_path": stored_path,
            "size": size,
            "mime": mime,
            "uploaded_at": now,
        }
        data[file_id] = rec
        self._write(data)
        return rec

    def delete(self, file_id: str) -> bool:
        data = self._read()
        if file_id not in data:
            return False
        data.pop(file_id, None)
        self._write(data)
        return True

    def _read(self) -> Dict[str, Any]:
        if not self.index_path.exists():
            return {}
        try:
            return load_yaml_file(self.index_path, default_factory=dict)
        except Exception:
            return {}

    def _write(self, data: Dict[str, Any]):
        save_yaml_file(self.index_path, data, default_flow_style=False, sort_keys=False)
