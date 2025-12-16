# -*- coding: utf-8 -*-
"""工作流 API（最小可用版：顺序节点列表 + 选择config）"""

from flask import Blueprint, request, jsonify

from workflows.models import WorkflowDefinition
from workflows.store import WorkflowStore
from workflows.engine import WorkflowEngine

workflow_bp = Blueprint('workflows', __name__, url_prefix='/api/workflows')

_store = None
_engine = None


def get_store() -> WorkflowStore:
    global _store
    if _store is None:
        _store = WorkflowStore()
    return _store


def get_engine() -> WorkflowEngine:
    global _engine
    if _engine is None:
        _engine = WorkflowEngine()
    return _engine


@workflow_bp.route('', methods=['GET'])
def list_workflows():
    items = get_store().list()
    return jsonify({
        "success": True,
        "workflows": [
            {
                "id": w.id,
                "name": w.name,
                "description": w.description,
                "node_count": len(w.nodes),
                "edge_count": len(getattr(w, 'edges', []) or []),
                "created_at": w.created_at,
                "updated_at": w.updated_at,
            }
            for w in items
        ]
    })


@workflow_bp.route('/<workflow_id>', methods=['GET'])
def get_workflow(workflow_id: str):
    wf = get_store().get(workflow_id)
    if not wf:
        return jsonify({"success": False, "error": "工作流不存在"}), 404
    return jsonify({"success": True, "workflow": wf.model_dump()})


@workflow_bp.route('', methods=['POST'])
def save_workflow():
    data = request.json or {}
    try:
        wf = WorkflowDefinition(**data)
    except Exception as e:
        return jsonify({"success": False, "error": f"工作流数据无效: {e}"}), 400

    # 若是更新已有工作流，保留 created_at
    existing = get_store().get(wf.id)
    if existing:
        wf.created_at = existing.created_at

    wf = get_store().save(wf)
    return jsonify({"success": True, "workflow": wf.model_dump()})


@workflow_bp.route('/<workflow_id>', methods=['DELETE'])
def delete_workflow(workflow_id: str):
    ok = get_store().delete(workflow_id)
    if ok:
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "工作流不存在"}), 404


@workflow_bp.route('/<workflow_id>/run', methods=['POST'])
def run_workflow(workflow_id: str):
    wf = get_store().get(workflow_id)
    if not wf:
        return jsonify({"success": False, "error": "工作流不存在"}), 404

    payload = request.json or {}
    initial_inputs = payload.get('initial_inputs') or {}

    try:
        result = get_engine().run(wf, initial_inputs=initial_inputs)
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
