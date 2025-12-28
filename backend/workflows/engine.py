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

    def _compile_initial_inputs(self, wf: WorkflowDefinition, initial_inputs: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        from file_index import FileIndex
        
        data: Dict[str, Any] = {}
        file_index = FileIndex()
        
        for v in (getattr(wf, 'variables', []) or []):
            if isinstance(v, dict):
                name = v.get('name')
                value = v.get('value')
                var_type = v.get('type', 'any')
                if name:
                    # 验证文件类型变量中的文件ID
                    if var_type in ['file_id', 'file_ids']:
                        if var_type == 'file_id' and value:
                            # 单个文件ID
                            if not file_index.get(value):
                                raise ValueError(f"工作流变量 '{name}' 引用的文件ID '{value}' 不存在")
                        elif var_type == 'file_ids' and value:
                            # 多个文件ID
                            if isinstance(value, list):
                                for file_id in value:
                                    if file_id and not file_index.get(file_id):
                                        raise ValueError(f"工作流变量 '{name}' 引用的文件ID '{file_id}' 不存在")
                    data[name] = value
            else:
                if getattr(v, 'name', None):
                    name = v.name
                    value = getattr(v, 'value', None)
                    var_type = getattr(v, 'type', 'any')
                    # 验证文件类型变量中的文件ID
                    if var_type in ['file_id', 'file_ids']:
                        if var_type == 'file_id' and value:
                            if not file_index.get(value):
                                raise ValueError(f"工作流变量 '{name}' 引用的文件ID '{value}' 不存在")
                        elif var_type == 'file_ids' and value:
                            if isinstance(value, list):
                                for file_id in value:
                                    if file_id and not file_index.get(file_id):
                                        raise ValueError(f"工作流变量 '{name}' 引用的文件ID '{file_id}' 不存在")
                    data[name] = value
        if initial_inputs:
            data.update(initial_inputs)
        return data

    def _compile_edges_from_bindings(self, wf: WorkflowDefinition) -> WorkflowDefinition:
        # 允许边仅作为“连接”(from_node_id -> to_node_id)，端口映射由 input_bindings 决定
        link_set = {(e.from_node_id, e.to_node_id) for e in (wf.edges or [])}

        compiled: List[WorkflowEdge] = []
        for n in wf.nodes:
            bindings = getattr(n, 'input_bindings', None) or {}
            for to_port, ref in bindings.items():
                if not ref:
                    continue
                if ref.startswith('var:'):
                    continue
                if not ref.startswith('node:'):
                    raise ValueError(f"节点 {n.id} 输入绑定格式无效: {to_port}={ref}")

                parts = ref.split(':', 2)
                if len(parts) != 3:
                    raise ValueError(f"节点 {n.id} 输入绑定格式无效: {to_port}={ref}")
                _, from_node_id, from_port = parts

                if (from_node_id, n.id) not in link_set:
                    raise ValueError(f"节点 {n.id} 绑定引用未建立连接: {from_node_id} -> {n.id}")

                compiled.append(
                    WorkflowEdge(
                        from_node_id=from_node_id,
                        from_port=from_port,
                        to_node_id=n.id,
                        to_port=to_port,
                    )
                )

        # 构造一个用于执行的 wf（仅替换 edges 为编译后的端口边）
        wf2 = wf.model_copy(deep=True)
        wf2.edges = compiled
        return wf2

    def run(self, wf: WorkflowDefinition, initial_inputs: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        initial_inputs = self._compile_initial_inputs(wf, initial_inputs)

        needs_compile = bool(getattr(wf, 'variables', []) or any(getattr(n, 'input_bindings', None) for n in (wf.nodes or [])))
        # 若 edges 存在空端口，也视为“仅连接”，需要编译
        if any((e.from_port is None or e.to_port is None) for e in (wf.edges or [])):
            needs_compile = True

        if needs_compile:
            wf = self._compile_edges_from_bindings(wf)

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
                # 验证配置中的文件ID
                config_dict = cfg.model_dump() if hasattr(cfg, 'model_dump') else cfg.dict()
                file_errors = node.validate_file_ids(config_dict)
                if file_errors:
                    raise ValueError(f"节点 {n.id} 文件ID验证失败: {'; '.join(file_errors)}")
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

            # Apply var bindings (var:xxx) first
            bindings = getattr(n, 'input_bindings', None) or {}
            for pname, ref in bindings.items():
                if pname in inputs:
                    continue
                if isinstance(ref, str) and ref.startswith('var:'):
                    vname = ref[4:]
                    if vname in initial_inputs:
                        inputs[pname] = initial_inputs[vname]

            # Fill from initial_inputs by same-name (fallback)
            for pname, pdef in to_inputs.items():
                if pname not in inputs and pname in initial_inputs:
                    inputs[pname] = initial_inputs[pname]

            # Required validation
            for pname, pdef in to_inputs.items():
                if pdef.get('required') and pname not in inputs:
                    raise ValueError(f"节点 {nid} 缺少必填输入: {pname}")

            # 验证输入约束（互斥、依赖等）
            input_errors = node.validate_inputs(inputs)
            if input_errors:
                raise ValueError(f"节点 {nid} 输入验证失败: {'; '.join(input_errors)}")

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
