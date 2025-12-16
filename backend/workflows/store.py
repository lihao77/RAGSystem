# -*- coding: utf-8 -*-
"""工作流存储（YAML 文件）"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Tuple, Dict, Any
import yaml
from datetime import datetime
import uuid

from .models import WorkflowDefinition


class WorkflowStore:
    def __init__(self, base_dir: str = None):
        if base_dir is None:
            base_dir = Path(__file__).parent.parent / "workflow_configs" / "user"
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _migrate_data_to_v2(self, data: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
        """一次性迁移：将旧版 edge 端口映射转为 nodes[].input_bindings，并将 edges 退化为 link。"""
        changed = False
        if not isinstance(data, dict):
            return {}, True

        # schema_version 缺省视为旧版
        if data.get('schema_version') != 2:
            data['schema_version'] = 2
            changed = True

        nodes = data.get('nodes') or []
        edges = data.get('edges') or []
        if not isinstance(nodes, list) or not isinstance(edges, list):
            return data, changed

        nodes_by_id = {n.get('id'): n for n in nodes if isinstance(n, dict) and n.get('id')}

        # 是否存在旧式端口边
        has_port_edges = any((isinstance(e, dict) and (e.get('from_port') or e.get('to_port'))) for e in edges)
        if not has_port_edges:
            # 仍然做一次 link 去重（避免历史数据重复连线）
            seen = set()
            new_edges = []
            for e in edges:
                if not isinstance(e, dict):
                    continue
                fn, tn = e.get('from_node_id'), e.get('to_node_id')
                if not fn or not tn:
                    continue
                key = (fn, tn)
                if key in seen:
                    changed = True
                    continue
                seen.add(key)
                new_edges.append({
                    'id': e.get('id') or str(uuid.uuid4())[:10],
                    'from_node_id': fn,
                    'from_port': None,
                    'to_node_id': tn,
                    'to_port': None,
                })
            if changed:
                data['edges'] = new_edges
            return data, changed

        # 迁移：edge(from_port,to_port) -> target.input_bindings[to_port] = node:from:from_port
        seen = set()
        new_edges = []
        for e in edges:
            if not isinstance(e, dict):
                changed = True
                continue
            fn, tn = e.get('from_node_id'), e.get('to_node_id')
            fp, tp = e.get('from_port'), e.get('to_port')
            if not fn or not tn:
                changed = True
                continue

            key = (fn, tn)
            if key not in seen:
                seen.add(key)
                new_edges.append({
                    'id': e.get('id') or str(uuid.uuid4())[:10],
                    'from_node_id': fn,
                    'from_port': None,
                    'to_node_id': tn,
                    'to_port': None,
                })
            else:
                # 多条端口边合并为一条 link
                changed = True

            if fp and tp:
                tgt = nodes_by_id.get(tn)
                if isinstance(tgt, dict):
                    ib = tgt.get('input_bindings') or {}
                    if not isinstance(ib, dict):
                        ib = {}
                    # 若已有绑定，优先保留已有（避免覆盖用户手工配置）
                    ib.setdefault(tp, f"node:{fn}:{fp}")
                    tgt['input_bindings'] = ib
                changed = True
            elif fp or tp:
                # 不完整旧边，丢弃端口信息
                changed = True

        data['edges'] = new_edges
        return data, changed

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
        raw = wf.model_dump()
        raw, _ = self._migrate_data_to_v2(raw)
        wf2 = WorkflowDefinition(**raw)

        f = self.base_dir / f"{wf2.id}.yaml"
        with open(f, 'w', encoding='utf-8') as fp:
            yaml.dump(wf2.model_dump(), fp, allow_unicode=True, default_flow_style=False)
        return wf2

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

            data, changed = self._migrate_data_to_v2(data)
            wf = WorkflowDefinition(**data)

            # 一次性迁移：写回磁盘，后续统一使用 v2
            if changed:
                with open(path, 'w', encoding='utf-8') as fp:
                    yaml.dump(wf.model_dump(), fp, allow_unicode=True, default_flow_style=False)

            return wf
        except Exception:
            return None
