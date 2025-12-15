# -*- coding: utf-8 -*-
"""工作流执行引擎（最小可用版：按节点顺序依次执行）"""

from __future__ import annotations

from typing import Dict, Any, Optional

from nodes import init_registry, NodeConfigStore
from .models import WorkflowDefinition


class WorkflowEngine:
    def __init__(self):
        self.registry = init_registry()
        self.config_store = NodeConfigStore()

    def run(self, wf: WorkflowDefinition, initial_inputs: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        initial_inputs = initial_inputs or {}

        outputs_by_node: Dict[str, Dict[str, Any]] = {}
        last_outputs: Dict[str, Any] = {}

        for idx, n in enumerate(wf.nodes):
            node_class = self.registry.get(n.node_type)
            node = node_class()

            if n.config_id:
                cfg = self.config_store.load_config(n.config_id, node_class)
                if cfg is None:
                    raise ValueError(f"节点 {n.id} 的 config_id 不存在: {n.config_id}")
                node.configure(cfg)
            else:
                node.configure(node_class.get_default_config())

            errors = node.validate()
            if errors:
                raise ValueError(f"节点 {n.id} 配置验证失败: {errors}")

            if idx == 0:
                node_inputs = initial_inputs
            else:
                node_inputs = dict(last_outputs)

            node_out = node.execute(node_inputs)
            outputs_by_node[n.id] = node_out
            last_outputs = node_out.get('outputs') if isinstance(node_out, dict) and 'outputs' in node_out else node_out

        return {
            "success": True,
            "workflow_id": wf.id,
            "workflow_name": wf.name,
            "node_outputs": outputs_by_node,
            "final_outputs": last_outputs,
        }
