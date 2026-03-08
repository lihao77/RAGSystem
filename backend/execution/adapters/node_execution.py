# -*- coding: utf-8 -*-
"""
Node 执行适配器。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from execution import ExecutionRequest, ExecutionResult, ExecutionStatus
from services.execution_service import ExecutionService, get_execution_service


class NodeExecutionAdapter:
    """将节点执行接入统一 execution layer。"""

    def __init__(self, execution_service: Optional[ExecutionService] = None):
        self._execution_service = execution_service or get_execution_service()

    def execute(self, payload: Optional[Dict[str, Any]], *, node_service) -> Dict[str, Any]:
        request_payload = payload or {}
        node_type = request_payload.get('node_type') or 'unknown'
        timeout_seconds = self._resolve_timeout_seconds(request_payload)

        result = self._execution_service.run(
            ExecutionRequest(
                execution_kind='node_execute',
                payload=request_payload,
                timeout_seconds=timeout_seconds,
                metadata={'node_type': node_type},
            ),
            target=lambda context: node_service.execute_node(context.payload),
        )
        return self._unwrap_result(result)

    @staticmethod
    def _resolve_timeout_seconds(payload: Dict[str, Any]) -> Optional[float]:
        timeout = payload.get('timeout_seconds')
        if timeout is None:
            config = payload.get('config') or {}
            timeout = config.get('timeout_seconds')
        if timeout is None:
            return None
        try:
            timeout_value = float(timeout)
        except (TypeError, ValueError):
            return None
        if timeout_value <= 0:
            return None
        return timeout_value

    @staticmethod
    def _unwrap_result(result: ExecutionResult) -> Dict[str, Any]:
        if result.status == ExecutionStatus.TIMED_OUT:
            raise TimeoutError(result.error or '节点执行超时')
        if result.status == ExecutionStatus.INTERRUPTED:
            raise RuntimeError(result.error or '节点执行已中断')
        if result.status == ExecutionStatus.FAILED:
            if isinstance(result.data, Exception):
                raise result.data
            raise RuntimeError(result.error or '节点执行失败')
        return result.data
