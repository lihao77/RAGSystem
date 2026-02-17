# -*- coding: utf-8 -*-
"""
会话级事件总线管理器

特性：
1. 每个会话（对话）有独立的事件总线实例
2. 自动清理过期会话
3. 线程安全
4. 支持会话重连
"""

import logging
import time
import threading
from typing import Dict, Optional
from datetime import datetime, timedelta

from .bus import EventBus

logger = logging.getLogger(__name__)


class SessionEventBusManager:
    """
    会话级事件总线管理器

    为每个会话（对话）维护独立的事件总线实例，避免不同会话的事件混淆。

    使用方式:
        manager = SessionEventBusManager()

        # 获取会话的事件总线
        event_bus = manager.get_or_create(session_id="abc123")

        # 使用事件总线
        event_bus.publish(...)

        # 会话结束时清理
        manager.remove(session_id="abc123")
    """

    def __init__(
        self,
        session_ttl: int = 3600,  # 会话过期时间（秒），默认1小时
        cleanup_interval: int = 300,  # 清理间隔（秒），默认5分钟
        enable_persistence: bool = True  # 是否启用事件持久化
    ):
        """
        初始化会话事件总线管理器

        Args:
            session_ttl: 会话过期时间（秒），超过此时间未活动的会话会被清理
            cleanup_interval: 自动清理间隔（秒）
            enable_persistence: 是否为所有会话启用事件持久化
        """
        self.session_ttl = session_ttl
        self.cleanup_interval = cleanup_interval
        self.enable_persistence = enable_persistence

        # 会话事件总线字典: {session_id: EventBus}
        self._session_buses: Dict[str, EventBus] = {}

        # 会话最后活跃时间: {session_id: timestamp}
        self._last_activity: Dict[str, float] = {}

        # 线程锁（保证线程安全）
        self._lock = threading.RLock()

        # 启动后台清理线程
        self._cleanup_thread = threading.Thread(
            target=self._cleanup_loop,
            daemon=True,
            name="EventBusCleanup"
        )
        self._cleanup_thread.start()

        logger.info(
            f"SessionEventBusManager 初始化 "
            f"(TTL: {session_ttl}s, 清理间隔: {cleanup_interval}s)"
        )

    def get_or_create(self, session_id: str) -> EventBus:
        """
        获取或创建会话的事件总线

        Args:
            session_id: 会话ID

        Returns:
            EventBus: 该会话专属的事件总线实例
        """
        with self._lock:
            # 更新最后活跃时间
            self._last_activity[session_id] = time.time()

            # 如果已存在，直接返回
            if session_id in self._session_buses:
                logger.debug(f"复用现有事件总线: {session_id}")
                return self._session_buses[session_id]

            # 创建新的事件总线
            event_bus = EventBus(enable_persistence=self.enable_persistence)
            self._session_buses[session_id] = event_bus

            logger.info(f"✨ 创建会话事件总线: {session_id}")
            return event_bus

    def get(self, session_id: str) -> Optional[EventBus]:
        """
        获取会话的事件总线（不创建）

        Args:
            session_id: 会话ID

        Returns:
            EventBus 或 None
        """
        with self._lock:
            if session_id in self._session_buses:
                # 更新最后活跃时间
                self._last_activity[session_id] = time.time()
                return self._session_buses[session_id]
            return None

    def remove(self, session_id: str) -> bool:
        """
        移除会话的事件总线

        Args:
            session_id: 会话ID

        Returns:
            bool: 是否成功移除
        """
        with self._lock:
            if session_id in self._session_buses:
                # 清理事件总线
                event_bus = self._session_buses[session_id]
                event_bus.clear_history()

                # 移除
                del self._session_buses[session_id]
                if session_id in self._last_activity:
                    del self._last_activity[session_id]

                logger.info(f"🗑️ 移除会话事件总线: {session_id}")
                return True

            return False

    def touch(self, session_id: str):
        """
        更新会话的最后活跃时间（保持会话活跃）

        Args:
            session_id: 会话ID
        """
        with self._lock:
            if session_id in self._session_buses:
                self._last_activity[session_id] = time.time()

    def get_active_sessions(self) -> list:
        """
        获取所有活跃会话ID列表

        Returns:
            list: 会话ID列表
        """
        with self._lock:
            return list(self._session_buses.keys())

    def get_session_stats(self, session_id: str) -> Optional[Dict]:
        """
        获取会话的统计信息

        Args:
            session_id: 会话ID

        Returns:
            dict: 统计信息，如果会话不存在则返回None
        """
        with self._lock:
            if session_id not in self._session_buses:
                return None

            event_bus = self._session_buses[session_id]
            stats = event_bus.get_stats()

            # 添加会话相关信息
            stats['session_id'] = session_id
            stats['last_activity'] = self._last_activity.get(session_id, 0)
            stats['age_seconds'] = time.time() - stats['last_activity']

            return stats

    def get_all_stats(self) -> Dict[str, Dict]:
        """
        获取所有会话的统计信息

        Returns:
            dict: {session_id: stats}
        """
        with self._lock:
            return {
                session_id: self.get_session_stats(session_id)
                for session_id in self._session_buses.keys()
            }

    def _cleanup_loop(self):
        """后台清理循环（在独立线程中运行）"""
        logger.info("事件总线清理线程已启动")

        while True:
            try:
                time.sleep(self.cleanup_interval)
                self._cleanup_expired_sessions()
            except Exception as e:
                logger.error(f"清理线程异常: {e}", exc_info=True)

    def _cleanup_expired_sessions(self):
        """清理过期的会话"""
        with self._lock:
            now = time.time()
            expired_sessions = []

            # 查找过期会话
            for session_id, last_activity in self._last_activity.items():
                age = now - last_activity
                if age > self.session_ttl:
                    expired_sessions.append(session_id)

            # 清理过期会话
            for session_id in expired_sessions:
                logger.info(f"🕒 清理过期会话: {session_id} (闲置 {(now - self._last_activity[session_id])/60:.1f} 分钟)")
                self.remove(session_id)

            if expired_sessions:
                logger.info(f"清理完成，移除 {len(expired_sessions)} 个过期会话")

    def shutdown(self):
        """关闭管理器，清理所有会话"""
        with self._lock:
            logger.info("关闭 SessionEventBusManager，清理所有会话...")

            session_ids = list(self._session_buses.keys())
            for session_id in session_ids:
                self.remove(session_id)

            logger.info(f"已清理 {len(session_ids)} 个会话")


# ==================== 全局管理器 ====================

_global_session_manager: Optional[SessionEventBusManager] = None


def get_session_manager(
    session_ttl: int = 3600,
    cleanup_interval: int = 300,
    enable_persistence: bool = True
) -> SessionEventBusManager:
    """
    获取全局会话事件总线管理器（单例）

    Args:
        session_ttl: 会话过期时间（秒）
        cleanup_interval: 清理间隔（秒）
        enable_persistence: 是否启用事件持久化

    Returns:
        SessionEventBusManager实例
    """
    global _global_session_manager
    if _global_session_manager is None:
        _global_session_manager = SessionEventBusManager(
            session_ttl=session_ttl,
            cleanup_interval=cleanup_interval,
            enable_persistence=enable_persistence
        )
    return _global_session_manager


# ==================== 便捷函数 ====================

def get_session_event_bus(session_id: str) -> EventBus:
    """
    获取会话的事件总线（便捷函数）

    Args:
        session_id: 会话ID

    Returns:
        EventBus实例
    """
    manager = get_session_manager()
    return manager.get_or_create(session_id)


def cleanup_session(session_id: str):
    """
    清理会话的事件总线（便捷函数）

    Args:
        session_id: 会话ID
    """
    manager = get_session_manager()
    manager.remove(session_id)


def touch_session(session_id: str):
    """
    保持会话活跃（便捷函数）

    Args:
        session_id: 会话ID
    """
    manager = get_session_manager()
    manager.touch(session_id)
