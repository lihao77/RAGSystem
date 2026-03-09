# -*- coding: utf-8 -*-
"""
MCP 执行适配器。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from agents.task_registry import TaskRegistry
from execution import ExecutionRequest, ExecutionResult, ExecutionStatus, InProcessExecutionRunner
from services.execution_service import ExecutionService, get_execution_service


class _NullSessionManager:
    def get(self, session_id: str):
        return None

    def get_or_create(self, session_id: str):
        return None


def _build_fallback_execution_service() -> ExecutionService:
    return ExecutionService(
        task_registry=TaskRegistry(),
        session_manager=_NullSessionManager(),
        runner=InProcessExecutionRunner(),
    )


class MCPExecutionAdapter:
    """将 MCP 操作接入统一 execution layer。"""

    def __init__(self, execution_service: Optional[ExecutionService] = None):
        if execution_service is not None:
            self._execution_service = execution_service
            return
        try:
            self._execution_service = get_execution_service()
        except RuntimeError:
            self._execution_service = _build_fallback_execution_service()

    def connect_server(
        self,
        server_name: str,
        *,
        manager,
        session_id: Optional[str] = None,
        run_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        result = self._execution_service.run(
            ExecutionRequest(
                execution_kind='mcp_connect',
                payload={'server_name': server_name},
                session_id=session_id,
                run_id=run_id,
                request_id=request_id,
                concurrency_key=f'mcp:server:{server_name}',
            ),
            target=lambda context: self._connect(manager, server_name),
        )
        return self._unwrap_result(result)

    def disconnect_server(
        self,
        server_name: str,
        *,
        manager,
        session_id: Optional[str] = None,
        run_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        result = self._execution_service.run(
            ExecutionRequest(
                execution_kind='mcp_disconnect',
                payload={'server_name': server_name},
                session_id=session_id,
                run_id=run_id,
                request_id=request_id,
                concurrency_key=f'mcp:server:{server_name}',
            ),
            target=lambda context: self._disconnect(manager, server_name),
        )
        return self._unwrap_result(result)

    def refresh_server(
        self,
        server_name: str,
        *,
        manager,
        session_id: Optional[str] = None,
        run_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        result = self._execution_service.run(
            ExecutionRequest(
                execution_kind='mcp_refresh',
                payload={'server_name': server_name},
                session_id=session_id,
                run_id=run_id,
                request_id=request_id,
                concurrency_key=f'mcp:server:{server_name}',
            ),
            target=lambda context: manager.refresh_server(server_name),
        )
        return self._unwrap_result(result)

    def test_server(
        self,
        server_name: str,
        *,
        manager,
        session_id: Optional[str] = None,
        run_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        result = self._execution_service.run(
            ExecutionRequest(
                execution_kind='mcp_test',
                payload={'server_name': server_name},
                session_id=session_id,
                run_id=run_id,
                request_id=request_id,
                concurrency_key=f'mcp:server:{server_name}',
            ),
            target=lambda context: manager.test_connection(server_name),
        )
        return self._unwrap_result(result)

    def call_tool(
        self,
        server_name: str,
        tool_name: str,
        arguments: dict,
        *,
        manager,
        session_id: Optional[str] = None,
        run_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> dict:
        result = self._execution_service.run(
            ExecutionRequest(
                execution_kind='mcp_tool_call',
                payload={
                    'server_name': server_name,
                    'tool_name': tool_name,
                    'arguments': arguments,
                },
                session_id=session_id,
                run_id=run_id,
                request_id=request_id,
                metadata={'server_name': server_name, 'tool_name': tool_name},
            ),
            target=lambda context: manager.call_tool(server_name, tool_name, arguments),
        )
        return self._unwrap_result(result)

    @staticmethod
    def _connect(manager, server_name: str) -> Dict[str, Any]:
        success = manager.connect_server(server_name)
        status = manager.get_server_status(server_name)
        return {'success': success, 'status': status}

    @staticmethod
    def _disconnect(manager, server_name: str) -> Dict[str, Any]:
        manager.disconnect_server(server_name)
        return {'status': manager.get_server_status(server_name)}

    @staticmethod
    def _unwrap_result(result: ExecutionResult):
        if result.status == ExecutionStatus.TIMED_OUT:
            raise TimeoutError(result.error or 'MCP 执行超时')
        if result.status == ExecutionStatus.INTERRUPTED:
            raise RuntimeError(result.error or 'MCP 执行已中断')
        if result.status == ExecutionStatus.FAILED:
            if isinstance(result.data, Exception):
                raise result.data
            raise RuntimeError(result.error or 'MCP 执行失败')
        return result.data
