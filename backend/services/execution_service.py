# -*- coding: utf-8 -*-
"""
执行层统一入口服务。
"""

from __future__ import annotations

import threading
from typing import Any, Callable, Dict, Optional

from agents.events.bus import Event, EventType
from execution import ExecutionContext, ExecutionHandle, ExecutionRequest, ExecutionResult, ExecutionStatus, InProcessExecutionRunner
from execution.observability import (
    attach_execution_metadata,
    extract_observability_fields,
    get_current_execution_observability,
    merge_observability_metadata,
)
from runtime.dependencies import get_runtime_dependency

from agents.events.session_manager import get_session_manager
from agents.task_registry import get_task_registry


class ExecutionService:
    """进程内最小 execution layer 入口。"""

    def __init__(self, task_registry=None, session_manager=None, runner=None):
        self._task_registry = task_registry or get_task_registry()
        self._session_manager = session_manager or get_session_manager()
        self._runner = runner or InProcessExecutionRunner()
        self._handles: Dict[str, ExecutionHandle] = {}
        self._lock = threading.RLock()

    def get_task_registry(self):
        return self._task_registry

    def get_session_manager(self):
        return self._session_manager

    def get_runner(self):
        return self._runner

    def build_context(
        self,
        request: ExecutionRequest,
        *,
        cancel_event=None,
        event_bus=None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ExecutionContext:
        task_id = request.resolved_task_id()
        inherited_observability = get_current_execution_observability()

        combined_metadata = dict(request.metadata)
        if metadata:
            combined_metadata.update(metadata)

        existing_fields = extract_observability_fields(combined_metadata)
        resolved_session_id = request.session_id or existing_fields.get('session_id')
        if resolved_session_id is None and inherited_observability is not None:
            resolved_session_id = inherited_observability.session_id

        resolved_run_id = request.run_id or existing_fields.get('run_id')
        if resolved_run_id is None and inherited_observability is not None:
            resolved_run_id = inherited_observability.run_id
        if resolved_run_id is None:
            resolved_run_id = task_id

        resolved_request_id = request.request_id or existing_fields.get('request_id')
        if resolved_request_id is None and inherited_observability is not None:
            resolved_request_id = inherited_observability.request_id

        resolved_event_bus = event_bus
        if resolved_event_bus is None and resolved_session_id:
            resolved_event_bus = self._session_manager.get_or_create(resolved_session_id)

        combined_metadata = merge_observability_metadata(
            combined_metadata,
            task_id=task_id,
            session_id=resolved_session_id,
            run_id=resolved_run_id,
            execution_kind=request.execution_kind,
            request_id=resolved_request_id,
        )

        return ExecutionContext(
            task_id=task_id,
            execution_kind=request.execution_kind,
            payload=request.payload,
            session_id=resolved_session_id,
            run_id=resolved_run_id,
            request_id=resolved_request_id,
            concurrency_key=request.concurrency_key,
            timeout_seconds=request.timeout_seconds,
            metadata=combined_metadata,
            cancel_event=cancel_event or threading.Event(),
            event_bus=resolved_event_bus,
            task_registry=self._task_registry,
        )

    def submit(
        self,
        request: ExecutionRequest,
        target: Callable[[ExecutionContext], Any],
        *,
        cancel_event=None,
        event_bus=None,
        metadata: Optional[Dict[str, Any]] = None,
        thread_name: Optional[str] = None,
    ) -> ExecutionHandle:
        context = self.build_context(
            request,
            cancel_event=cancel_event,
            event_bus=event_bus,
            metadata=metadata,
        )
        self._ensure_task_registered(context)
        wrapped_target = self._wrap_target(context, target)
        handle = self._runner.submit(context=context, target=wrapped_target, thread_name=thread_name)
        self._task_registry.mark_running(context.task_id, thread=handle.thread)
        with self._lock:
            self._handles[handle.task_id] = handle
        return handle

    def run(
        self,
        request: ExecutionRequest,
        target: Callable[[ExecutionContext], Any],
        *,
        cancel_event=None,
        event_bus=None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ExecutionResult:
        handle = self.submit(
            request,
            target,
            cancel_event=cancel_event,
            event_bus=event_bus,
            metadata=metadata,
        )
        result = handle.join(timeout=(request.timeout_seconds + 0.5) if request.timeout_seconds is not None else None)
        if result is not None:
            return result

        status = self.get_status(handle.task_id)
        if status is None:
            raise RuntimeError(f'执行结果丢失: task_id={handle.task_id}')
        return ExecutionResult(
            success=False,
            status=ExecutionStatus(status.get('raw_status', status['status'])),
            error='execution did not finish',
            started_at=status['started_at'],
            finished_at=status.get('finished_at') or status['started_at'],
        )

    def cancel(self, task_id: str) -> bool:
        cancelled = bool(self._task_registry.cancel_task(task_id))

        with self._lock:
            handle = self._handles.get(task_id)
        if handle is not None:
            cancelled = handle.cancel() or cancelled
        return cancelled

    def cancel_session(self, session_id: str, *, publish_interrupt: bool = True, reason: str = 'user_stop') -> bool:
        status = self.get_status_by_session(session_id)
        if status is None:
            return False

        if publish_interrupt:
            event_bus = None
            session_manager_get = getattr(self._session_manager, 'get', None)
            if callable(session_manager_get):
                event_bus = session_manager_get(session_id)
            if event_bus is None:
                event_bus = self._session_manager.get_or_create(session_id)
            event_bus.publish(Event(
                type=EventType.USER_INTERRUPT,
                data=attach_execution_metadata(
                    {'reason': reason},
                    task_id=status.get('task_id'),
                    session_id=session_id,
                    run_id=status.get('run_id'),
                    execution_kind=status.get('execution_kind'),
                    request_id=status.get('request_id'),
                ),
                session_id=session_id,
            ))

        task_id = status.get('task_id')
        if not task_id:
            return False
        return self.cancel(task_id)

    def get_status(self, task_id: str) -> Optional[Dict[str, Any]]:
        status = self._sync_handle_result(task_id, self._task_registry.get_task_status(task_id))
        self._release_finished_handle(task_id, status)
        return status

    def get_status_by_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        status = self._task_registry.get_status(session_id)
        if status is not None:
            status = self._sync_handle_result(status.get('task_id'), status)
            self._release_finished_handle(status.get('task_id'), status)
        return status

    def cleanup_finished(self, max_age_seconds: float = 300) -> None:
        self._sync_finished_handles()
        self._task_registry.cleanup_finished(max_age_seconds=max_age_seconds)
        self._cleanup_finished_handles()

    def _ensure_task_registered(self, context: ExecutionContext) -> None:
        existing = self._task_registry.get_task_status(context.task_id)
        if existing is not None:
            return

        registered_task_id = self._task_registry.register_task(
            session_id=context.session_id,
            run_id=context.run_id or context.task_id,
            request_id=context.request_id,
            task=self._describe_task(context),
            cancel_event=context.cancel_event,
            status='starting',
            execution_kind=context.execution_kind,
            concurrency_key=context.concurrency_key,
            timeout_seconds=context.timeout_seconds,
            task_id=context.task_id,
        )
        if registered_task_id is None:
            raise RuntimeError(f'执行任务注册失败: task_id={context.task_id}')

    def _wrap_target(self, context: ExecutionContext, target: Callable[[ExecutionContext], Any]) -> Callable[[ExecutionContext], Any]:
        def wrapped(current_context: ExecutionContext) -> Any:
            try:
                result = target(current_context)
            except Exception:
                self._task_registry.finish_task(current_context.task_id, status='failed')
                raise

            if isinstance(result, ExecutionResult):
                self._task_registry.finish_task(current_context.task_id, status=result.status.value)
                return result

            self._task_registry.finish_task(current_context.task_id, status='completed')
            return result

        return wrapped

    @staticmethod
    def _describe_task(context: ExecutionContext) -> str:
        payload = context.payload
        if isinstance(payload, dict):
            task = payload.get('task') or payload.get('server_name') or payload.get('node_type')
            if task:
                return str(task)
        if payload is None:
            return context.execution_kind
        return str(payload)

    def _sync_finished_handles(self) -> None:
        with self._lock:
            task_ids = list(self._handles.keys())
        for task_id in task_ids:
            status = self._task_registry.get_task_status(task_id)
            self._sync_handle_result(task_id, status)

    def _sync_handle_result(self, task_id: Optional[str], status: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not task_id:
            return status
        with self._lock:
            handle = self._handles.get(task_id)
        if handle is None:
            return status

        result = handle.result
        if result is None:
            return status

        raw_status = status.get('raw_status') if status is not None else None
        if status is None or raw_status != result.status.value:
            self._task_registry.finish_task(task_id, status=result.status.value)
            return self._task_registry.get_task_status(task_id)
        return status

    def _cleanup_finished_handles(self) -> None:
        with self._lock:
            task_ids = list(self._handles.keys())
        for task_id in task_ids:
            status = self._task_registry.get_task_status(task_id)
            self._release_finished_handle(task_id, status)

    def _release_finished_handle(self, task_id: Optional[str], status: Optional[Dict[str, Any]]) -> None:
        if not task_id:
            return
        with self._lock:
            handle = self._handles.get(task_id)
            if handle is None:
                return
            if handle.is_alive():
                return
            if status is None or status.get('raw_status') not in {'starting', 'running', 'cancel_requested'}:
                self._handles.pop(task_id, None)


_execution_service: Optional[ExecutionService] = None


def get_execution_service() -> ExecutionService:
    global _execution_service
    return get_runtime_dependency(
        container_getter='get_execution_service',
        fallback_name='execution_service',
        fallback_factory=ExecutionService,
        require_container=True,
        legacy_getter=lambda: _execution_service,
        legacy_setter=lambda instance: globals().__setitem__('_execution_service', instance),
    )
