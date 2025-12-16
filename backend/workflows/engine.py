# -*- coding: utf-8 -*-
"""工作流执行引擎（DAG：拓扑排序 + 按连线组装输入）"""

from __future__ import annotations

from typing import Dict, Any, Optional, List

from nodes import init_registry, NodeConfigStore
from .models import WorkflowDefinition, WorkflowEdge


def _port_map(defn_ports: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {p.get('name'): p for p in (defn_ports or []) if p.get('name')}


class WorkflowEngine:
    def __init__(self):
        self.registry = init_registry()
        self.config_store = NodeConfigStore()

    def run(self, wf: WorkflowDefinition, initial_inputs: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        initial_inputs = initial_inputs or {}

        node_map = {n.id: n for n in wf.nodes}
        if not node_map:
            return {"success": True, "workflow_id": wf.id, "workflow_name": wf.name, "node_outputs": {}, "final_outputs": {}}

        # Validate edges endpoints
        for e in wf.edges:
            if e.from_node_id not in node_map:
                raise ValueError(f"edge.from_node_id 不存在: {e.from_node_id}")
            if e.to_node_id not in node_map:
                raise ValueError(f"edge.to_node_id 不存在: {e.to_node_id}")

        # Build graph
        in_degree: Dict[str, int] = {nid: 0 for nid in node_map.keys()}
        outgoing: Dict[str, List[WorkflowEdge]] = {nid: [] for nid in node_map.keys()}
        incoming: Dict[str, List[WorkflowEdge]] = {nid: [] for nid in node_map.keys()}

        for e in wf.edges:
            outgoing[e.from_node_id].append(e)
            incoming[e.to_node_id].append(e)
            in_degree[e.to_node_id] += 1

        # Topological sort (Kahn)
        queue = [nid for nid, deg in in_degree.items() if deg == 0]
        topo: List[str] = []
        while queue:
            nid = queue.pop(0)
            topo.append(nid)
            for e in outgoing.get(nid, []):
                in_degree[e.to_node_id] -= 1
                if in_degree[e.to_node_id] == 0:
                    queue.append(e.to_node_id)

        if len(topo) != len(node_map):
            raise ValueError("工作流存在循环依赖，无法执行")

        outputs_by_node: Dict[str, Dict[str, Any]] = {}

        # Preload node definitions (ports) for validation
        def_cache: Dict[str, Dict[str, Any]] = {}
        for nid in topo:
            n = node_map[nid]
            node_class = self.registry.get(n.node_type)
            defn = node_class.get_definition().model_dump()
            def_cache[nid] = defn

        # Edge type/port validation (minimal)
        for e in wf.edges:
            from_def = def_cache[e.from_node_id]
            to_def = def_cache[e.to_node_id]
            from_out = _port_map(from_def.get('outputs', []))
            to_in = _port_map(to_def.get('inputs', []))

            if e.from_port not in from_out:
                raise ValueError(f"边 {e.id} 的 from_port 不存在: {e.from_port}")
            if e.to_port not in to_in:
                raise ValueError(f"边 {e.id} 的 to_port 不存在: {e.to_port}")

            t1 = (from_out[e.from_port].get('type') or 'any')
            t2 = (to_in[e.to_port].get('type') or 'any')
            if t1 != 'any' and t2 != 'any' and t1 != t2:
                raise ValueError(f"边 {e.id} 类型不匹配: {e.from_port}({t1}) -> {e.to_port}({t2})")

        # Execute nodes
        for nid in topo:
            n = node_map[nid]
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

            # Assemble inputs from incoming edges
            inputs: Dict[str, Any] = {}
            to_def = def_cache[nid]
            to_inputs = _port_map(to_def.get('inputs', []))

            for e in incoming.get(nid, []):
                from_out_raw = outputs_by_node.get(e.from_node_id, {})
                from_out = from_out_raw.get('outputs') if isinstance(from_out_raw, dict) and 'outputs' in from_out_raw else from_out_raw
                val = None
                if isinstance(from_out, dict):
                    val = from_out.get(e.from_port)

                port_cfg = to_inputs.get(e.to_port) or {}
                if port_cfg.get('multiple'):
                    inputs.setdefault(e.to_port, [])
                    inputs[e.to_port].append(val)
                else:
                    inputs[e.to_port] = val

            # Fill from initial_inputs if not already provided
            for pname, pdef in to_inputs.items():
                if pname not in inputs and pname in initial_inputs:
                    inputs[pname] = initial_inputs[pname]

            # Required validation
            for pname, pdef in to_inputs.items():
                if pdef.get('required') and pname not in inputs:
                    raise ValueError(f"节点 {nid} 缺少必填输入: {pname}")

            node_out = node.execute(inputs)
            outputs_by_node[nid] = node_out

        # Sinks
        sinks = [nid for nid in node_map.keys() if len(outgoing.get(nid, [])) == 0]
        final_outputs = {}
        for nid in sinks:
            out_raw = outputs_by_node.get(nid, {})
            out = out_raw.get('outputs') if isinstance(out_raw, dict) and 'outputs' in out_raw else out_raw
            final_outputs[nid] = out

        return {
            "success": True,
            "workflow_id": wf.id,
            "workflow_name": wf.name,
            "topo_order": topo,
            "node_outputs": outputs_by_node,
            "final_outputs": final_outputs,
        }
