# -*- coding: utf-8 -*-
"""
工作流服务层。
"""

from __future__ import annotations

from runtime.dependencies import get_runtime_dependency
from typing import Any, Dict, Optional

from workflows.engine import WorkflowEngine
from workflows.models import WorkflowDefinition
from workflows.store import WorkflowStore


class WorkflowServiceError(Exception):
    """工作流业务异常。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class WorkflowService:
    """封装工作流的查询、保存、删除和执行逻辑。"""

    def __init__(self, store: Optional[WorkflowStore] = None, engine: Optional[WorkflowEngine] = None):
        self._store = store or WorkflowStore()
        self._engine = engine or WorkflowEngine()

    def list_workflows(self) -> list[Dict[str, Any]]:
        items = self._store.list()
        return [
            {
                'id': workflow.id,
                'name': workflow.name,
                'description': workflow.description,
                'node_count': len(workflow.nodes),
                'edge_count': len(getattr(workflow, 'edges', []) or []),
                'created_at': workflow.created_at,
                'updated_at': workflow.updated_at,
            }
            for workflow in items
        ]

    def get_workflow(self, workflow_id: str) -> Dict[str, Any]:
        workflow = self._store.get(workflow_id)
        if workflow is None:
            raise WorkflowServiceError('工作流不存在', status_code=404)
        return workflow.model_dump()

    def save_workflow(self, data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        payload = data or {}
        try:
            workflow = WorkflowDefinition(**payload)
        except Exception as error:
            raise WorkflowServiceError(f'工作流数据无效: {error}', status_code=400) from error

        workflow.schema_version = 2

        existing = self._store.get(workflow.id)
        if existing is not None:
            workflow.created_at = existing.created_at

        saved = self._store.save(workflow)
        return saved.model_dump()

    def delete_workflow(self, workflow_id: str) -> None:
        ok = self._store.delete(workflow_id)
        if not ok:
            raise WorkflowServiceError('工作流不存在', status_code=404)

    def run_workflow(self, workflow_id: str, initial_inputs: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        workflow = self._store.get(workflow_id)
        if workflow is None:
            raise WorkflowServiceError('工作流不存在', status_code=404)

        try:
            return self._engine.run(workflow, initial_inputs=initial_inputs or {})
        except WorkflowServiceError:
            raise
        except Exception as error:
            raise WorkflowServiceError(str(error), status_code=500) from error


_workflow_service: Optional[WorkflowService] = None


def get_workflow_service() -> WorkflowService:
    global _workflow_service
    return get_runtime_dependency(
        container_getter='get_workflow_service',
        fallback_name='workflow_service',
        fallback_factory=WorkflowService,
        legacy_getter=lambda: _workflow_service,
        legacy_setter=lambda instance: globals().__setitem__('_workflow_service', instance),
    )
