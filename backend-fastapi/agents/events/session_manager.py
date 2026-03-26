# -*- coding: utf-8 -*-
"""
Run 级事件总线管理器。

兼容历史命名：
- 旧接口仍叫 session_manager / get_session_event_bus
- 实际底层按 run_id 管理 EventBus
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Dict, Optional

from runtime.dependencies import get_runtime_dependency

from .bus import EventBus

logger = logging.getLogger(__name__)


class RunEventBusManager:
    """为每个 run 维护独立的事件总线实例。"""

    def __init__(
        self,
        session_ttl: int = 3600,
        cleanup_interval: int = 300,
        enable_persistence: bool = True,
        max_history: int = 1000,
    ):
        self.session_ttl = session_ttl
        self.cleanup_interval = cleanup_interval
        self.enable_persistence = enable_persistence
        self.max_history = max_history

        self._run_buses: Dict[str, EventBus] = {}
        self._last_activity: Dict[str, float] = {}
        self._run_to_session: Dict[str, Optional[str]] = {}
        self._lock = threading.RLock()
        self._shutdown_event = threading.Event()

        self._cleanup_thread = threading.Thread(
            target=self._cleanup_loop,
            daemon=True,
            name="EventBusCleanup",
        )
        self._cleanup_thread.start()

        logger.info(
            "RunEventBusManager 初始化 (TTL: %ss, 清理间隔: %ss, 最大历史: %s)",
            session_ttl,
            cleanup_interval,
            max_history,
        )

    def get_or_create(self, run_id: str, *, session_id: Optional[str] = None) -> EventBus:
        with self._lock:
            self._last_activity[run_id] = time.time()
            if run_id in self._run_buses:
                if session_id is not None:
                    self._run_to_session[run_id] = session_id
                logger.debug("复用现有 run 事件总线: run_id=%s", run_id)
                return self._run_buses[run_id]

            event_bus = EventBus(
                enable_persistence=self.enable_persistence,
                max_history=self.max_history,
            )
            self._run_buses[run_id] = event_bus
            self._run_to_session[run_id] = session_id
            logger.info("✨ 创建 run 事件总线: run_id=%s session_id=%s", run_id, session_id)
            return event_bus

    def get(self, run_id: str) -> Optional[EventBus]:
        with self._lock:
            event_bus = self._run_buses.get(run_id)
            if event_bus is not None:
                self._last_activity[run_id] = time.time()
            return event_bus

    def remove(self, run_id: str) -> bool:
        with self._lock:
            event_bus = self._run_buses.get(run_id)
            if event_bus is None:
                return False

            session_id = self._run_to_session.get(run_id)
            try:
                from .bus import Event, EventType

                event_bus._publish_sync(Event(
                    type=EventType.SESSION_END,
                    data={'reason': 'run_removed', 'run_id': run_id},
                    session_id=session_id,
                ))
            except Exception:
                pass

            event_bus.clear_history()
            self._run_buses.pop(run_id, None)
            self._last_activity.pop(run_id, None)
            self._run_to_session.pop(run_id, None)
            logger.info("🗑️ 移除 run 事件总线: run_id=%s session_id=%s", run_id, session_id)
            return True

    def mark_run_ended(self, run_id: str) -> None:
        return None

    def touch(self, run_id: str) -> None:
        with self._lock:
            if run_id in self._run_buses:
                self._last_activity[run_id] = time.time()

    def get_session_run_id(self, session_id: str) -> Optional[str]:
        from agents.task_registry import get_task_registry

        status = get_task_registry().get_status(session_id)
        if status is None:
            return None
        return status.get('run_id')

    def get_by_session(self, session_id: str) -> Optional[EventBus]:
        run_id = self.get_session_run_id(session_id)
        if not run_id:
            return None
        return self.get(run_id)

    def remove_by_session(self, session_id: str) -> bool:
        run_id = self.get_session_run_id(session_id)
        if not run_id:
            return False
        return self.remove(run_id)

    def touch_session(self, session_id: str) -> None:
        run_id = self.get_session_run_id(session_id)
        if run_id:
            self.touch(run_id)

    def get_active_runs(self) -> list[str]:
        with self._lock:
            return list(self._run_buses.keys())

    def get_run_stats(self, run_id: str) -> Optional[Dict]:
        with self._lock:
            event_bus = self._run_buses.get(run_id)
            if event_bus is None:
                return None
            stats = event_bus.get_stats()
            stats['run_id'] = run_id
            stats['session_id'] = self._run_to_session.get(run_id)
            stats['last_activity'] = self._last_activity.get(run_id, 0)
            stats['age_seconds'] = time.time() - stats['last_activity']
            return stats

    def get_all_stats(self) -> Dict[str, Dict]:
        with self._lock:
            run_ids = list(self._run_buses.keys())
        return {
            run_id: self.get_run_stats(run_id)
            for run_id in run_ids
        }

    def _cleanup_loop(self) -> None:
        logger.info("事件总线清理线程已启动")
        while not self._shutdown_event.wait(self.cleanup_interval):
            try:
                self._cleanup_expired_runs()
            except Exception as error:
                logger.error("清理线程异常: %s", error, exc_info=True)
        logger.info("事件总线清理线程已停止")

    def _cleanup_expired_runs(self) -> None:
        now = time.time()
        expired_run_ids = []
        with self._lock:
            for run_id, last_activity in self._last_activity.items():
                if (now - last_activity) > self.session_ttl:
                    expired_run_ids.append(run_id)

        for run_id in dict.fromkeys(expired_run_ids):
            logger.info("🕒 清理过期 run: %s", run_id)
            self.remove(run_id)

        if expired_run_ids:
            logger.info("清理完成，移除 %s 个过期 run", len(dict.fromkeys(expired_run_ids)))

    def shutdown(self) -> None:
        logger.info("关闭 RunEventBusManager，清理所有 run...")
        self._shutdown_event.set()

        current_thread = threading.current_thread()
        if self._cleanup_thread.is_alive() and self._cleanup_thread is not current_thread:
            self._cleanup_thread.join(timeout=1)

        with self._lock:
            run_ids = list(self._run_buses.keys())
        for run_id in run_ids:
            self.remove(run_id)
        logger.info("已清理 %s 个 run", len(run_ids))


SessionEventBusManager = RunEventBusManager


def get_session_manager(
    session_ttl: int = 3600,
    cleanup_interval: int = 300,
    enable_persistence: bool = True,
    max_history: int = 1000,
) -> RunEventBusManager:
    return get_runtime_dependency(
        container_resolver=lambda c: c.get_session_manager(
            session_ttl=session_ttl,
            cleanup_interval=cleanup_interval,
            enable_persistence=enable_persistence,
            max_history=max_history,
        ),
    )


def get_run_event_bus(run_id: str, *, session_id: Optional[str] = None) -> EventBus:
    manager = get_session_manager()
    return manager.get_or_create(run_id, session_id=session_id)


def cleanup_run(run_id: str) -> bool:
    manager = get_session_manager()
    return manager.remove(run_id)


def touch_run(run_id: str) -> None:
    manager = get_session_manager()
    manager.touch(run_id)


def get_session_event_bus(session_id: str) -> EventBus:
    manager = get_session_manager()
    event_bus = manager.get_by_session(session_id)
    if event_bus is not None:
        return event_bus
    raise KeyError(f"session_id={session_id} 没有对应的活跃 run 事件总线")


def cleanup_session(session_id: str) -> bool:
    manager = get_session_manager()
    return manager.remove_by_session(session_id)


def touch_session(session_id: str) -> None:
    manager = get_session_manager()
    manager.touch_session(session_id)
