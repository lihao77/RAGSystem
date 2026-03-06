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
import uuid
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
    # 待审批请求：approval_id -> threading.Event
    pending_approvals: Dict[str, threading.Event] = field(default_factory=dict)
    # 审批结果：approval_id -> {"approved": bool, "message": str}
    approval_results: Dict[str, dict] = field(default_factory=dict)
    # 待用户输入请求：input_id -> threading.Event
    pending_inputs: Dict[str, threading.Event] = field(default_factory=dict)
    # 用户输入结果：input_id -> str
    input_results: Dict[str, str] = field(default_factory=dict)


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
        """设置 cancel_event 取消任务，同时拒绝所有待审批和待输入请求"""
        with self._lock:
            info = self._tasks.get(session_id)
            if info and info.status == "running":
                info.cancel_event.set()
                # 拒绝所有待审批，唤醒阻塞中的工具线程
                pending_count = len(info.pending_approvals)
                for aid, evt in list(info.pending_approvals.items()):
                    info.approval_results[aid] = {"approved": False, "message": ""}
                    evt.set()
                info.pending_approvals.clear()
                # 取消所有待输入，唤醒阻塞中的 agent 线程
                input_count = len(info.pending_inputs)
                for iid, evt in list(info.pending_inputs.items()):
                    info.input_results[iid] = ""
                    evt.set()
                info.pending_inputs.clear()
                logger.info(
                    f"TaskRegistry: 取消任务 session={session_id}，"
                    f"拒绝 {pending_count} 个待审批，取消 {input_count} 个待输入"
                )
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

    def add_pending_approval(self, session_id: str, approval_id: str) -> Optional[threading.Event]:
        """
        注册一个待审批请求，返回用于阻塞等待的 Event。
        工具执行线程调用此方法后应 wait() 该 Event。
        """
        with self._lock:
            info = self._tasks.get(session_id)
            if not info:
                return None
            evt = threading.Event()
            info.pending_approvals[approval_id] = evt
            info.approval_results[approval_id] = {"approved": False, "message": ""}  # 默认拒绝
            logger.info(f"TaskRegistry: 注册审批请求 session={session_id} approval_id={approval_id}")
            return evt

    def resolve_approval(self, session_id: str, approval_id: str, approved: bool, message: str = "") -> bool:
        """
        响应审批请求（由 HTTP 端点调用）。
        返回 True 表示找到并成功响应，False 表示未找到。
        """
        with self._lock:
            info = self._tasks.get(session_id)
            if not info or approval_id not in info.pending_approvals:
                logger.warning(f"TaskRegistry: 未找到审批请求 session={session_id} approval_id={approval_id}")
                return False
            info.approval_results[approval_id] = {"approved": approved, "message": message}
            evt = info.pending_approvals.pop(approval_id)
        # 锁外 set，避免死锁
        evt.set()
        logger.info(f"TaskRegistry: 审批响应 session={session_id} approval_id={approval_id} approved={approved}")
        return True

    def get_approval_result(self, session_id: str, approval_id: str) -> tuple:
        """获取审批结果（等待完成后调用），返回 (approved: bool, message: str)"""
        with self._lock:
            info = self._tasks.get(session_id)
            if not info:
                return False, ""
            result = info.approval_results.pop(approval_id, {"approved": False, "message": ""})
            return result.get("approved", False), result.get("message", "")

    # ── 用户输入等待机制 ──────────────────────────────────────────

    def add_pending_input(self, session_id: str, input_id: str) -> Optional[threading.Event]:
        """
        注册一个待用户输入请求，返回用于阻塞等待的 Event。
        Agent 线程调用此方法后应 wait() 该 Event。
        """
        with self._lock:
            info = self._tasks.get(session_id)
            if not info:
                return None
            evt = threading.Event()
            info.pending_inputs[input_id] = evt
            info.input_results[input_id] = ""  # 默认空字符串
            logger.info(f"TaskRegistry: 注册用户输入请求 session={session_id} input_id={input_id}")
            return evt

    def resolve_input(self, session_id: str, input_id: str, value: str) -> bool:
        """
        提交用户输入（由 HTTP 端点调用）。
        返回 True 表示找到并成功响应，False 表示未找到。
        """
        with self._lock:
            info = self._tasks.get(session_id)
            if not info or input_id not in info.pending_inputs:
                logger.warning(f"TaskRegistry: 未找到输入请求 session={session_id} input_id={input_id}")
                return False
            info.input_results[input_id] = value
            evt = info.pending_inputs.pop(input_id)
        # 锁外 set，避免死锁
        evt.set()
        logger.info(f"TaskRegistry: 用户输入已提交 session={session_id} input_id={input_id}")
        return True

    def get_input_result(self, session_id: str, input_id: str) -> str:
        """获取用户输入结果（等待完成后调用）"""
        with self._lock:
            info = self._tasks.get(session_id)
            if not info:
                return ""
            return info.input_results.pop(input_id, "")


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
