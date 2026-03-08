# -*- coding: utf-8 -*-
"""
内存级任务注册表 — 追踪每个 session 的执行状态。

用于：
- 防止同一 session 并发执行多个任务
- 前端断连后感知任务是否仍在运行
- 页面刷新后恢复 loading 状态
- 为后续 execution layer 提供 task-aware 状态与取消能力
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from runtime.dependencies import get_runtime_dependency

logger = logging.getLogger(__name__)

_ACTIVE_STATUSES = {'starting', 'running', 'cancel_requested'}


@dataclass
class TaskInfo:
    task_id: str
    session_id: Optional[str]
    run_id: str
    request_id: Optional[str]
    task: str
    started_at: float
    thread: Optional[threading.Thread] = None
    cancel_event: Optional[threading.Event] = None
    status: str = 'running'
    execution_kind: str = 'legacy'
    concurrency_key: Optional[str] = None
    timeout_seconds: Optional[float] = None
    finished_at: Optional[float] = None
    persistent_subscriptions: List[str] = field(default_factory=list)
    event_bus: Optional[Any] = field(default=None, repr=False)
    pending_approvals: Dict[str, threading.Event] = field(default_factory=dict)
    approval_results: Dict[str, dict] = field(default_factory=dict)
    pending_inputs: Dict[str, threading.Event] = field(default_factory=dict)
    input_results: Dict[str, str] = field(default_factory=dict)


class TaskRegistry:
    """内存级任务注册表（线程安全单例）。"""

    def __init__(self):
        self._tasks: Dict[str, TaskInfo] = {}
        self._tasks_by_task_id: Dict[str, TaskInfo] = {}
        self._active_concurrency: Dict[str, str] = {}
        self._lock = threading.RLock()

    def register(
        self,
        session_id: str,
        run_id: str,
        task: str,
        thread: threading.Thread,
        cancel_event: threading.Event,
    ) -> bool:
        """兼容旧接口：按 session 注册 Agent 任务。"""
        task_id = self.register_task(
            session_id=session_id,
            run_id=run_id,
            task=task,
            thread=thread,
            cancel_event=cancel_event,
            status='running',
            execution_kind='agent_run',
            concurrency_key=f'session:{session_id}',
        )
        return task_id is not None

    def register_task(
        self,
        *,
        session_id: Optional[str] = None,
        run_id: str = '',
        request_id: Optional[str] = None,
        task: str = '',
        thread: Optional[threading.Thread] = None,
        cancel_event: Optional[threading.Event] = None,
        status: str = 'starting',
        execution_kind: str = 'generic',
        concurrency_key: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
        task_id: Optional[str] = None,
    ) -> Optional[str]:
        """按 task_id 注册任务，支持 starting/running 等状态。"""
        resolved_task_id = task_id or str(uuid.uuid4())
        resolved_cancel_event = cancel_event or threading.Event()

        with self._lock:
            if resolved_task_id in self._tasks_by_task_id:
                logger.warning('TaskRegistry: task_id=%s 已存在，拒绝重复注册', resolved_task_id)
                return None

            conflict = self._find_active_conflict_locked(session_id=session_id, concurrency_key=concurrency_key)
            if conflict is not None:
                logger.warning(
                    'TaskRegistry: 存在活跃任务冲突，拒绝注册 task_id=%s session=%s conflict_task_id=%s conflict_status=%s',
                    resolved_task_id,
                    session_id,
                    conflict.task_id,
                    conflict.status,
                )
                return None

            info = TaskInfo(
                task_id=resolved_task_id,
                session_id=session_id,
                run_id=run_id,
                request_id=request_id,
                task=task,
                started_at=time.time(),
                thread=thread,
                cancel_event=resolved_cancel_event,
                status=status,
                execution_kind=execution_kind,
                concurrency_key=concurrency_key,
                timeout_seconds=timeout_seconds,
            )
            self._tasks_by_task_id[resolved_task_id] = info
            if session_id and self._should_bind_session_slot_locked(info):
                self._tasks[session_id] = info
            self._sync_concurrency_index_locked(info)

        logger.info(
            'TaskRegistry: 注册任务 task_id=%s session=%s run_id=%s request_id=%s kind=%s status=%s',
            resolved_task_id,
            session_id,
            run_id,
            request_id,
            execution_kind,
            status,
        )
        return resolved_task_id

    def mark_running(self, task_id: str, thread: Optional[threading.Thread] = None) -> bool:
        """将 starting 任务转为 running，可同时补挂 thread。"""
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None:
                return False
            self._refresh_zombie_state_locked(info)
            if info.finished_at is not None or info.status not in {'starting', 'running'}:
                return False
            if thread is not None:
                info.thread = thread
            info.status = 'running'
            self._sync_concurrency_index_locked(info)
            return True

    def update_task_status(self, task_id: str, status: str) -> bool:
        """按 task_id 更新状态。"""
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None:
                return False
            info.status = status
            if status not in _ACTIVE_STATUSES and info.finished_at is None:
                info.finished_at = time.time()
            self._sync_concurrency_index_locked(info)
            return True

    def finish_task(self, task_id: str, status: str = 'completed') -> bool:
        """按 task_id 标记任务结束。"""
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None:
                return False
            if info.finished_at is None:
                info.finished_at = time.time()
            info.status = status
            self._sync_concurrency_index_locked(info)
            logger.info('TaskRegistry: 任务结束 task_id=%s session=%s status=%s', task_id, info.session_id, status)
            return True

    def unregister(self, session_id: str, status: str = 'completed'):
        """兼容旧接口：按 session 标记任务结束。"""
        with self._lock:
            info = self._get_session_task_locked(session_id)
            if info is None:
                return
            task_id = info.task_id
        self.finish_task(task_id, status=status)

    def get_task_status(self, task_id: str) -> Optional[dict]:
        """按 task_id 获取任务状态。"""
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None:
                return None
            self._refresh_zombie_state_locked(info)
            return self._build_status_snapshot_locked(info)

    def get_status(self, session_id: str) -> Optional[dict]:
        """兼容旧接口：按 session 获取任务状态。"""
        with self._lock:
            info = self._get_session_task_locked(session_id)
            if info is None:
                return None
            self._refresh_zombie_state_locked(info)
            return self._build_status_snapshot_locked(info)

    def cancel_task(self, task_id: str) -> bool:
        """按 task_id 发起协作式取消，同时唤醒待审批和待输入。"""
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None:
                return False
            self._refresh_zombie_state_locked(info)
            if info.status not in _ACTIVE_STATUSES:
                return False

            info.status = 'cancel_requested'
            if info.cancel_event is not None:
                info.cancel_event.set()

            pending_count = len(info.pending_approvals)
            for approval_id, evt in list(info.pending_approvals.items()):
                info.approval_results[approval_id] = {'approved': False, 'message': ''}
                evt.set()
            info.pending_approvals.clear()

            input_count = len(info.pending_inputs)
            for input_id, evt in list(info.pending_inputs.items()):
                info.input_results[input_id] = ''
                evt.set()
            info.pending_inputs.clear()
            self._sync_concurrency_index_locked(info)

        logger.info(
            'TaskRegistry: 取消任务 task_id=%s session=%s，拒绝 %s 个待审批，取消 %s 个待输入',
            task_id,
            info.session_id,
            pending_count,
            input_count,
        )
        return True

    def cancel(self, session_id: str) -> bool:
        """兼容旧接口：按 session 发起取消。"""
        task_id = self.get_task_id_by_session(session_id)
        if task_id is None:
            return False
        return self.cancel_task(task_id)

    def cleanup_finished(self, max_age_seconds: float = 300):
        """清理已完成且超过 max_age_seconds 的记录。"""
        now = time.time()
        with self._lock:
            to_remove = [
                task_id
                for task_id, info in self._tasks_by_task_id.items()
                if info.status not in _ACTIVE_STATUSES
                and info.finished_at is not None
                and (now - info.finished_at) > max_age_seconds
            ]
            for task_id in to_remove:
                self._remove_task_locked(task_id)
            if to_remove:
                logger.debug('TaskRegistry: 清理 %s 条过期记录', len(to_remove))

    def set_persistent_subscriptions(self, session_id: str, subscription_ids: List[str], event_bus: Any):
        """设置持久化订阅 ID 和 EventBus 引用（兼容旧接口）。"""
        task_id = self.get_task_id_by_session(session_id)
        if task_id is not None:
            self.set_task_persistent_subscriptions(task_id, subscription_ids, event_bus)

    def cleanup_subscriptions(self, session_id: str):
        """清理持久化订阅（兼容旧接口）。"""
        task_id = self.get_task_id_by_session(session_id)
        if task_id is not None:
            self.cleanup_task_subscriptions(task_id)

    def add_pending_approval(self, session_id: str, approval_id: str) -> Optional[threading.Event]:
        """注册待审批请求。"""
        task_id = self.get_task_id_by_session(session_id)
        if task_id is None:
            return None
        return self.add_task_pending_approval(task_id, approval_id)

    def resolve_approval(self, session_id: str, approval_id: str, approved: bool, message: str = '') -> bool:
        """响应审批请求（由 HTTP 端点调用）。"""
        task_id = self.get_task_id_by_session(session_id)
        if task_id is None:
            return False
        return self.resolve_task_approval(task_id, approval_id, approved, message)

    def get_approval_result(self, session_id: str, approval_id: str) -> tuple:
        """获取审批结果（等待完成后调用），返回 (approved: bool, message: str)。"""
        task_id = self.get_task_id_by_session(session_id)
        if task_id is None:
            return False, ''
        return self.get_task_approval_result(task_id, approval_id)

    def add_pending_input(self, session_id: str, input_id: str) -> Optional[threading.Event]:
        """注册待用户输入请求。"""
        task_id = self.get_task_id_by_session(session_id)
        if task_id is None:
            return None
        return self.add_task_pending_input(task_id, input_id)

    def resolve_input(self, session_id: str, input_id: str, value: str) -> bool:
        """提交用户输入（由 HTTP 端点调用）。"""
        task_id = self.get_task_id_by_session(session_id)
        if task_id is None:
            return False
        return self.resolve_task_input(task_id, input_id, value)

    def get_input_result(self, session_id: str, input_id: str) -> str:
        """获取用户输入结果（等待完成后调用）。"""
        task_id = self.get_task_id_by_session(session_id)
        if task_id is None:
            return ''
        return self.get_task_input_result(task_id, input_id)

    def add_task_pending_approval(self, task_id: str, approval_id: str) -> Optional[threading.Event]:
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None:
                return None
            evt = threading.Event()
            info.pending_approvals[approval_id] = evt
            info.approval_results[approval_id] = {'approved': False, 'message': ''}
            logger.info('TaskRegistry: 注册审批请求 task_id=%s approval_id=%s', task_id, approval_id)
            return evt

    def resolve_task_approval(self, task_id: str, approval_id: str, approved: bool, message: str = '') -> bool:
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None or approval_id not in info.pending_approvals:
                logger.warning('TaskRegistry: 未找到审批请求 task_id=%s approval_id=%s', task_id, approval_id)
                return False
            info.approval_results[approval_id] = {'approved': approved, 'message': message}
            evt = info.pending_approvals.pop(approval_id)
        evt.set()
        logger.info('TaskRegistry: 审批响应 task_id=%s approval_id=%s approved=%s', task_id, approval_id, approved)
        return True

    def get_task_approval_result(self, task_id: str, approval_id: str) -> tuple:
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None:
                return False, ''
            result = info.approval_results.pop(approval_id, {'approved': False, 'message': ''})
            return result.get('approved', False), result.get('message', '')

    def add_task_pending_input(self, task_id: str, input_id: str) -> Optional[threading.Event]:
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None:
                return None
            evt = threading.Event()
            info.pending_inputs[input_id] = evt
            info.input_results[input_id] = ''
            logger.info('TaskRegistry: 注册用户输入请求 task_id=%s input_id=%s', task_id, input_id)
            return evt

    def resolve_task_input(self, task_id: str, input_id: str, value: str) -> bool:
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None or input_id not in info.pending_inputs:
                logger.warning('TaskRegistry: 未找到输入请求 task_id=%s input_id=%s', task_id, input_id)
                return False
            info.input_results[input_id] = value
            evt = info.pending_inputs.pop(input_id)
        evt.set()
        logger.info('TaskRegistry: 用户输入已提交 task_id=%s input_id=%s', task_id, input_id)
        return True

    def get_task_input_result(self, task_id: str, input_id: str) -> str:
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None:
                return ''
            return info.input_results.pop(input_id, '')

    def get_task_id_by_session(self, session_id: str) -> Optional[str]:
        with self._lock:
            info = self._get_session_task_locked(session_id)
            return info.task_id if info is not None else None

    def set_task_persistent_subscriptions(self, task_id: str, subscription_ids: List[str], event_bus: Any) -> bool:
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if info is None:
                return False
            info.persistent_subscriptions = subscription_ids
            info.event_bus = event_bus
            return True

    def cleanup_task_subscriptions(self, task_id: str):
        with self._lock:
            info = self._tasks_by_task_id.get(task_id)
            if not info:
                return
            bus = info.event_bus
            subs = info.persistent_subscriptions
            info.persistent_subscriptions = []
            info.event_bus = None
            session_id = info.session_id

        if bus and subs:
            for sub_id in subs:
                try:
                    bus.unsubscribe(sub_id)
                except Exception as error:
                    logger.debug('TaskRegistry: 清理订阅 %s 失败: %s', sub_id, error)
            logger.info('TaskRegistry: 已清理 %s 个持久化订阅 session=%s task_id=%s', len(subs), session_id, task_id)

    def _get_session_task_locked(self, session_id: str) -> Optional[TaskInfo]:
        return self._tasks.get(session_id)

    def _find_active_conflict_locked(
        self,
        *,
        session_id: Optional[str],
        concurrency_key: Optional[str],
    ) -> Optional[TaskInfo]:
        if concurrency_key:
            task_id = self._active_concurrency.get(concurrency_key)
            if task_id is not None:
                info = self._tasks_by_task_id.get(task_id)
                if info is not None:
                    self._refresh_zombie_state_locked(info)
                    if info.status in _ACTIVE_STATUSES:
                        return info
                self._active_concurrency.pop(concurrency_key, None)

        return None

    def _should_bind_session_slot_locked(self, info: TaskInfo) -> bool:
        if not info.session_id:
            return False

        current = self._tasks.get(info.session_id)
        if current is None:
            return True

        self._refresh_zombie_state_locked(current)
        if current.status not in _ACTIVE_STATUSES:
            return True

        session_concurrency_key = f'session:{info.session_id}'
        return info.concurrency_key == session_concurrency_key

    def _refresh_zombie_state_locked(self, info: TaskInfo) -> None:
        if info.status not in _ACTIVE_STATUSES:
            self._sync_concurrency_index_locked(info)
            return
        if info.thread is None or info.thread.is_alive():
            self._sync_concurrency_index_locked(info)
            return

        previous_status = info.status
        info.status = 'interrupted' if previous_status == 'cancel_requested' else 'failed'
        info.finished_at = info.finished_at or time.time()
        self._sync_concurrency_index_locked(info)
        logger.warning(
            'TaskRegistry: 检测到僵尸任务 task_id=%s session=%s，线程已死但状态为 %s，自动修正为 %s',
            info.task_id,
            info.session_id,
            previous_status,
            info.status,
        )

    def _sync_concurrency_index_locked(self, info: TaskInfo) -> None:
        if not info.concurrency_key:
            return
        current = self._active_concurrency.get(info.concurrency_key)
        if info.status in _ACTIVE_STATUSES:
            self._active_concurrency[info.concurrency_key] = info.task_id
            return
        if current == info.task_id:
            self._active_concurrency.pop(info.concurrency_key, None)

    def _build_status_snapshot_locked(self, info: TaskInfo) -> dict:
        thread_alive = bool(info.thread and info.thread.is_alive())
        finished_at = info.finished_at
        elapsed_end = finished_at or time.time()
        display_status = 'running' if info.status in _ACTIVE_STATUSES else info.status
        return {
            'task_id': info.task_id,
            'status': display_status,
            'raw_status': info.status,
            'run_id': info.run_id,
            'request_id': info.request_id,
            'task': info.task,
            'execution_kind': info.execution_kind,
            'session_id': info.session_id,
            'concurrency_key': info.concurrency_key,
            'timeout_seconds': info.timeout_seconds,
            'started_at': info.started_at,
            'finished_at': finished_at,
            'elapsed_seconds': round(elapsed_end - info.started_at, 1),
            'thread_alive': thread_alive,
        }

    def _remove_task_locked(self, task_id: str) -> None:
        info = self._tasks_by_task_id.pop(task_id, None)
        if info is None:
            return
        if info.session_id and self._tasks.get(info.session_id) is info:
            self._tasks.pop(info.session_id, None)
        if info.concurrency_key and self._active_concurrency.get(info.concurrency_key) == task_id:
            self._active_concurrency.pop(info.concurrency_key, None)


_registry: Optional[TaskRegistry] = None


def get_task_registry() -> TaskRegistry:
    global _registry
    return get_runtime_dependency(
        container_getter='get_task_registry',
        fallback_name='task_registry',
        fallback_factory=TaskRegistry,
        require_container=True,
        legacy_getter=lambda: _registry,
        legacy_setter=lambda instance: globals().__setitem__('_registry', instance),
    )
