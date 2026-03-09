# -*- coding: utf-8 -*-
"""
进程内执行 runner。
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from .models import ExecutionContext, ExecutionHandle, ExecutionResult, ExecutionStatus
from .observability import ExecutionObservabilityContext, execution_observability_scope

logger = logging.getLogger(__name__)


@dataclass
class _ExecutionState:
    status: ExecutionStatus
    started_at: float
    finished_at: Optional[float] = None
    result: Optional[ExecutionResult] = None
    error: Optional[str] = None

    def __post_init__(self) -> None:
        self.lock = threading.RLock()
        self.done_event = threading.Event()

    def mark_running(self) -> None:
        with self.lock:
            if self.done_event.is_set():
                return
            self.status = ExecutionStatus.RUNNING

    def request_cancel(self, cancel_event: threading.Event) -> bool:
        with self.lock:
            if self.done_event.is_set():
                return False
            self.status = ExecutionStatus.CANCEL_REQUESTED
            cancel_event.set()
            return True

    def mark_timed_out(self) -> bool:
        with self.lock:
            if self.done_event.is_set():
                return False
            finished_at = time.time()
            self.status = ExecutionStatus.TIMED_OUT
            self.finished_at = finished_at
            self.error = 'execution timed out'
            self.result = ExecutionResult(
                success=False,
                status=ExecutionStatus.TIMED_OUT,
                error=self.error,
                started_at=self.started_at,
                finished_at=finished_at,
            )
            self.done_event.set()
            return True

    def mark_completed(self, data: Any) -> bool:
        with self.lock:
            if self.done_event.is_set():
                return False
            finished_at = time.time()
            self.status = ExecutionStatus.COMPLETED
            self.finished_at = finished_at
            self.result = ExecutionResult(
                success=True,
                status=ExecutionStatus.COMPLETED,
                data=data,
                started_at=self.started_at,
                finished_at=finished_at,
            )
            self.done_event.set()
            return True

    def mark_interrupted(self, data: Any = None) -> bool:
        with self.lock:
            if self.done_event.is_set():
                return False
            finished_at = time.time()
            self.status = ExecutionStatus.INTERRUPTED
            self.finished_at = finished_at
            self.error = 'execution interrupted'
            self.result = ExecutionResult(
                success=False,
                status=ExecutionStatus.INTERRUPTED,
                data=data,
                error=self.error,
                started_at=self.started_at,
                finished_at=finished_at,
            )
            self.done_event.set()
            return True

    def mark_failed(self, error: Exception) -> bool:
        with self.lock:
            if self.done_event.is_set():
                return False
            finished_at = time.time()
            self.status = ExecutionStatus.FAILED
            self.finished_at = finished_at
            self.error = str(error)
            self.result = ExecutionResult(
                success=False,
                status=ExecutionStatus.FAILED,
                data=error,
                error=self.error,
                started_at=self.started_at,
                finished_at=finished_at,
            )
            self.done_event.set()
            return True

    def set_result(self, result: ExecutionResult) -> bool:
        with self.lock:
            if self.done_event.is_set():
                return False
            self.status = result.status
            self.finished_at = result.finished_at
            self.error = result.error
            self.result = result
            self.done_event.set()
            return True

    def snapshot(self, *, thread, task_id: str, execution_kind: str, session_id: Optional[str], run_id: Optional[str], request_id: Optional[str], timeout_seconds: Optional[float]) -> Dict[str, Any]:
        with self.lock:
            return {
                'task_id': task_id,
                'execution_kind': execution_kind,
                'session_id': session_id,
                'run_id': run_id,
                'request_id': request_id,
                'status': self.status.value,
                'started_at': self.started_at,
                'finished_at': self.finished_at,
                'timeout_seconds': timeout_seconds,
                'thread_alive': bool(thread and thread.is_alive()),
                'error': self.error,
            }


class InProcessExecutionRunner:
    """基于线程的进程内执行 runner。"""

    def submit(
        self,
        *,
        context: ExecutionContext,
        target: Callable[[ExecutionContext], Any],
        thread_name: Optional[str] = None,
        daemon: bool = True,
    ) -> ExecutionHandle:
        started_at = time.time()
        state = _ExecutionState(status=ExecutionStatus.STARTING, started_at=started_at)
        thread_holder: Dict[str, Optional[threading.Thread]] = {'thread': None}
        observability = ExecutionObservabilityContext(
            task_id=context.task_id,
            session_id=context.session_id,
            run_id=context.run_id,
            execution_kind=context.execution_kind,
            request_id=context.request_id,
        )

        def run_target() -> None:
            with execution_observability_scope(observability):
                state.mark_running()
                try:
                    result = target(context)
                except Exception as error:
                    logger.error('执行任务失败 task_id=%s kind=%s: %s', context.task_id, context.execution_kind, error, exc_info=True)
                    state.mark_failed(error)
                    return

                if isinstance(result, ExecutionResult):
                    state.set_result(result)
                    return

                snapshot = state.snapshot(
                    thread=thread_holder['thread'],
                    task_id=context.task_id,
                    execution_kind=context.execution_kind,
                    session_id=context.session_id,
                    run_id=context.run_id,
                    request_id=context.request_id,
                    timeout_seconds=context.timeout_seconds,
                )
                if context.cancel_event.is_set() or snapshot['status'] == ExecutionStatus.CANCEL_REQUESTED.value:
                    state.mark_interrupted(result)
                    return
                state.mark_completed(result)

        worker = threading.Thread(
            target=run_target,
            name=thread_name or f'execution-{context.execution_kind}-{context.task_id[:8]}',
            daemon=daemon,
        )
        thread_holder['thread'] = worker
        worker.start()

        if context.timeout_seconds is not None:
            monitor = threading.Thread(
                target=self._monitor_timeout,
                args=(context, worker, state),
                name=f'execution-timeout-{context.task_id[:8]}',
                daemon=True,
            )
            monitor.start()

        return ExecutionHandle(
            task_id=context.task_id,
            execution_kind=context.execution_kind,
            session_id=context.session_id,
            run_id=context.run_id,
            request_id=context.request_id,
            timeout_seconds=context.timeout_seconds,
            started_at=started_at,
            thread=worker,
            snapshot_getter=lambda: state.snapshot(
                thread=thread_holder['thread'],
                task_id=context.task_id,
                execution_kind=context.execution_kind,
                session_id=context.session_id,
                run_id=context.run_id,
                request_id=context.request_id,
                timeout_seconds=context.timeout_seconds,
            ),
            result_getter=lambda: state.result,
            cancel_callback=lambda: state.request_cancel(context.cancel_event),
        )

    def run(self, *, context: ExecutionContext, target: Callable[[ExecutionContext], Any]) -> ExecutionResult:
        handle = self.submit(context=context, target=target, daemon=True)

        deadline = None
        if context.timeout_seconds is not None:
            deadline = time.time() + context.timeout_seconds + 0.5

        while True:
            result = handle.result
            if result is not None:
                return result

            if handle.thread is not None and not handle.thread.is_alive():
                break

            if deadline is not None and time.time() >= deadline:
                break

            time.sleep(0.01)

        snapshot = handle.get_status()
        return ExecutionResult(
            success=False,
            status=ExecutionStatus(snapshot['status']),
            error=snapshot.get('error') or 'execution did not finish',
            started_at=snapshot['started_at'],
            finished_at=snapshot.get('finished_at') or time.time(),
        )

    @staticmethod
    def _monitor_timeout(context: ExecutionContext, worker: threading.Thread, state: _ExecutionState) -> None:
        worker.join(timeout=context.timeout_seconds)
        if worker.is_alive() and state.mark_timed_out():
            context.cancel_event.set()
