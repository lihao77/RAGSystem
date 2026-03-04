# -*- coding: utf-8 -*-
"""
内存级任务注册表 — 追踪每个 session 的执行状态

用于：
- 防止同一 session 并发执行多个任务
- 前端断连后感知任务是否仍在运行
- 页面刷新后恢复 loading 状态
"""

import threading
import time
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class TaskInfo:
    session_id: str
    run_id: str
    task: str
    started_at: float
    thread: threading.Thread
    cancel_event: threading.Event
    status: str = "running"  # running | completed | failed | interrupted
    finished_at: Optional[float] = None
    # 持久化订阅 ID 列表（跟随 Agent 线程生命周期，线程结束时清理）
    persistent_subscriptions: List[str] = field(default_factory=list)
    # 对应的 EventBus 引用（用于清理订阅）
    event_bus: Optional[Any] = field(default=None, repr=False)


class TaskRegistry:
    """内存级任务注册表（线程安全单例）"""

    def __init__(self):
        self._tasks: Dict[str, TaskInfo] = {}
        self._lock = threading.RLock()

    def register(self, session_id: str, run_id: str, task: str,
                 thread: threading.Thread, cancel_event: threading.Event) -> bool:
        """
        注册新任务。若该 session 已有运行中任务且线程存活则拒绝。

        Returns:
            True — 注册成功；False — 该 session 有正在运行的任务
        """
        with self._lock:
            existing = self._tasks.get(session_id)
            if existing and existing.status == "running" and existing.thread.is_alive():
                logger.warning(
                    f"TaskRegistry: session {session_id} 已有运行中任务 "
                    f"(run_id={existing.run_id})，拒绝新任务注册"
                )
                return False
            self._tasks[session_id] = TaskInfo(
                session_id=session_id,
                run_id=run_id,
                task=task,
                started_at=time.time(),
                thread=thread,
                cancel_event=cancel_event,
            )
            logger.info(f"TaskRegistry: 注册任务 session={session_id} run_id={run_id}")
            return True

    def unregister(self, session_id: str, status: str = "completed"):
        """标记任务结束"""
        with self._lock:
            info = self._tasks.get(session_id)
            if info and info.status == "running":
                info.status = status
                info.finished_at = time.time()
                logger.info(f"TaskRegistry: 任务结束 session={session_id} status={status}")

    def get_status(self, session_id: str) -> Optional[dict]:
        """
        获取任务状态。

        自动修正：线程已死但 status 还是 running → 改为 failed。
        """
        with self._lock:
            info = self._tasks.get(session_id)
            if info is None:
                return None
            # 自动修正僵尸状态
            if info.status == "running" and not info.thread.is_alive():
                info.status = "failed"
                info.finished_at = time.time()
                logger.warning(
                    f"TaskRegistry: 检测到僵尸任务 session={session_id}，"
                    f"线程已死但状态为 running，自动修正为 failed"
                )
            return {
                "status": info.status,
                "run_id": info.run_id,
                "task": info.task,
                "started_at": info.started_at,
                "elapsed_seconds": round(time.time() - info.started_at, 1),
                "thread_alive": info.thread.is_alive(),
            }

    def cancel(self, session_id: str) -> bool:
        """设置 cancel_event 取消任务"""
        with self._lock:
            info = self._tasks.get(session_id)
            if info and info.status == "running":
                info.cancel_event.set()
                logger.info(f"TaskRegistry: 取消任务 session={session_id}")
                return True
            return False

    def cleanup_finished(self, max_age_seconds: float = 300):
        """清理已完成且超过 max_age_seconds 的记录"""
        now = time.time()
        with self._lock:
            to_remove = [
                sid for sid, info in self._tasks.items()
                if info.status != "running"
                and info.finished_at is not None
                and (now - info.finished_at) > max_age_seconds
            ]
            for sid in to_remove:
                del self._tasks[sid]
            if to_remove:
                logger.debug(f"TaskRegistry: 清理 {len(to_remove)} 条过期记录")

    def set_persistent_subscriptions(self, session_id: str,
                                     subscription_ids: List[str],
                                     event_bus: Any):
        """设置持久化订阅 ID 和 EventBus 引用（注册后调用）"""
        with self._lock:
            info = self._tasks.get(session_id)
            if info:
                info.persistent_subscriptions = subscription_ids
                info.event_bus = event_bus

    def cleanup_subscriptions(self, session_id: str):
        """清理持久化订阅（Agent 线程结束时调用）"""
        with self._lock:
            info = self._tasks.get(session_id)
            if not info:
                return
            bus = info.event_bus
            subs = info.persistent_subscriptions
            info.persistent_subscriptions = []
            info.event_bus = None

        # 在锁外执行 unsubscribe，避免潜在死锁
        if bus and subs:
            for sub_id in subs:
                try:
                    bus.unsubscribe(sub_id)
                except Exception as e:
                    logger.debug(f"TaskRegistry: 清理订阅 {sub_id} 失败: {e}")
            logger.info(f"TaskRegistry: 已清理 {len(subs)} 个持久化订阅 session={session_id}")


# ── 全局单例 ──

_registry: Optional[TaskRegistry] = None
_registry_lock = threading.Lock()


def get_task_registry() -> TaskRegistry:
    global _registry
    if _registry is None:
        with _registry_lock:
            if _registry is None:
                _registry = TaskRegistry()
    return _registry
