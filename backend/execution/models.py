# -*- coding: utf-8 -*-
"""
执行层基础模型。
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, Optional


class ExecutionStatus(str, Enum):
    """统一执行状态。"""

    STARTING = 'starting'
    RUNNING = 'running'
    CANCEL_REQUESTED = 'cancel_requested'
    COMPLETED = 'completed'
    FAILED = 'failed'
    INTERRUPTED = 'interrupted'
    TIMED_OUT = 'timed_out'


@dataclass(slots=True)
class ExecutionRequest:
    """一次执行请求。"""

    execution_kind: str
    payload: Any = None
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    concurrency_key: Optional[str] = None
    timeout_seconds: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    task_id: Optional[str] = None

    def resolved_task_id(self) -> str:
        return self.task_id or str(uuid.uuid4())


@dataclass(slots=True)
class ExecutionResult:
    """执行结果。"""

    success: bool
    status: ExecutionStatus
    data: Any = None
    error: Optional[str] = None
    started_at: float = field(default_factory=time.time)
    finished_at: float = field(default_factory=time.time)


@dataclass(slots=True)
class ExecutionContext:
    """执行上下文。"""

    task_id: str
    execution_kind: str
    cancel_event: threading.Event
    payload: Any = None
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    concurrency_key: Optional[str] = None
    timeout_seconds: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    event_bus: Any = None
    task_registry: Any = None


class ExecutionHandle:
    """已提交执行任务的句柄。"""

    def __init__(
        self,
        *,
        task_id: str,
        execution_kind: str,
        session_id: Optional[str],
        run_id: Optional[str],
        timeout_seconds: Optional[float],
        started_at: float,
        thread,
        snapshot_getter: Callable[[], Dict[str, Any]],
        result_getter: Callable[[], Optional[ExecutionResult]],
        cancel_callback: Callable[[], bool],
    ):
        self.task_id = task_id
        self.execution_kind = execution_kind
        self.session_id = session_id
        self.run_id = run_id
        self.timeout_seconds = timeout_seconds
        self.started_at = started_at
        self.thread = thread
        self._snapshot_getter = snapshot_getter
        self._result_getter = result_getter
        self._cancel_callback = cancel_callback

    def cancel(self) -> bool:
        return self._cancel_callback()

    def join(self, timeout: Optional[float] = None) -> Optional[ExecutionResult]:
        if self.thread is not None:
            self.thread.join(timeout=timeout)
        return self.result

    @property
    def result(self) -> Optional[ExecutionResult]:
        return self._result_getter()

    def get_status(self) -> Dict[str, Any]:
        return self._snapshot_getter()

    def is_alive(self) -> bool:
        return bool(self.thread and self.thread.is_alive())
