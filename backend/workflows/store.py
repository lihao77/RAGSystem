# -*- coding: utf-8 -*-
"""工作流存储（YAML 文件）"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional
import yaml
from datetime import datetime

from .models import WorkflowDefinition


class WorkflowStore:
    def __init__(self, base_dir: str = None):
        if base_dir is None:
            base_dir = Path(__file__).parent.parent / "workflow_configs" / "user"
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def list(self) -> List[WorkflowDefinition]:
        items: List[WorkflowDefinition] = []
        for f in sorted(self.base_dir.glob("*.yaml")):
            wf = self._load_file(f)
            if wf:
                items.append(wf)
        return items

    def get(self, workflow_id: str) -> Optional[WorkflowDefinition]:
        f = self.base_dir / f"{workflow_id}.yaml"
        return self._load_file(f)

    def save(self, wf: WorkflowDefinition) -> WorkflowDefinition:
        wf.updated_at = datetime.now().isoformat()
        f = self.base_dir / f"{wf.id}.yaml"
        with open(f, 'w', encoding='utf-8') as fp:
            yaml.dump(wf.model_dump(), fp, allow_unicode=True, default_flow_style=False)
        return wf

    def delete(self, workflow_id: str) -> bool:
        f = self.base_dir / f"{workflow_id}.yaml"
        if f.exists():
            f.unlink()
            return True
        return False

    def _load_file(self, path: Path) -> Optional[WorkflowDefinition]:
        if not path.exists():
            return None
        try:
            with open(path, 'r', encoding='utf-8') as fp:
                data = yaml.safe_load(fp) or {}
            return WorkflowDefinition(**data)
        except Exception:
            return None
