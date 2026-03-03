# -*- coding: utf-8 -*-
"""
事件总线 - Agent系统的统一事件通信机制

设计理念：
1. 解耦Agent与前端展示
2. 支持双向通信（Agent → Frontend, Frontend → Agent）
3. 支持异步事件处理
4. 支持事件持久化与审计
5. 支持用户许可机制（Human-in-the-Loop）
"""

import asyncio
import logging
import time
import uuid
import threading  # ✨ 添加 threading 导入
from typing import Dict, List, Callable, Any, Optional, Coroutine
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from collections import defaultdict
from contextvars import ContextVar

logger = logging.getLogger(__name__)


# ==================== 事件类型定义 ====================

class EventType(str, Enum):
    """事件类型枚举"""

    # 运行生命周期
    RUN_START = "run.start"
    RUN_END = "run.end"

    # Agent生命周期（通用）
    AGENT_START = "agent.start"
    AGENT_END = "agent.end"
    AGENT_ERROR = "agent.error"

    # 思考过程事件
    THOUGHT = "agent.thought"                       # 兼容旧代码
    THOUGHT_STRUCTURED = "agent.thought_structured"  # 兼容旧代码
    THINKING = "agent.thinking"                      # 新名称（等同 THOUGHT）
    THINKING_STRUCTURED = "agent.thinking_structured" # 新名称（等同 THOUGHT_STRUCTURED）

    # 流式思考事件（新增）
    THINKING_DELTA = "agent.thinking_delta"          # thinking 增量内容
    THINKING_COMPLETE = "agent.thinking_complete"    # thinking 完成

    # 调用生命周期（Agent）
    CALL_AGENT_START = "call.agent.start"
    CALL_AGENT_END = "call.agent.end"

    # 调用生命周期（Tool）
    CALL_TOOL_START = "call.tool.start"
    CALL_TOOL_END = "call.tool.end"
    
    # 兼容旧 Tool 事件（可选，若不需要可移除）
    TOOL_START = "tool.start"
    TOOL_END = "tool.end"
    TOOL_ERROR = "tool.error"

    # 流式输出事件
    CHUNK = "output.chunk"
    FINAL_ANSWER = "output.final_answer"
    MESSAGE_SAVED = "output.message_saved"  # 消息持久化完成，携带 id/seq 供前端补全

    # 可视化事件
    CHART_GENERATED = "visualization.chart"
    MAP_GENERATED = "visualization.map"

    # 用户交互事件 (Human-in-the-Loop)
    USER_APPROVAL_REQUIRED = "user.approval_required"
    USER_APPROVAL_GRANTED = "user.approval_granted"
    USER_APPROVAL_DENIED = "user.approval_denied"
    USER_INTERRUPT = "user.interrupt"
    USER_FEEDBACK = "user.feedback"

    # ReAct 中间过程事件
    REACT_INTERMEDIATE = "react.intermediate"

    # 上下文压缩事件
    COMPRESSION_SUMMARY = "context.compression_summary"

    # 上下文用量事件
    CONTEXT_USAGE = "context.usage"

    # 代码执行事件（PTC）
    CODE_EXECUTION_START = "code.execution.start"
    CODE_EXECUTION_END = "code.execution.end"

    # 系统事件
    SESSION_START = "session.start"
    SESSION_END = "session.end"
    ERROR = "system.error"


class EventPriority(int, Enum):
    """事件优先级"""
    LOW = 0
    NORMAL = 1
    HIGH = 2
    CRITICAL = 3


@dataclass
class Event:
    """事件数据结构"""

    # 基础字段
    type: EventType
    data: Dict[str, Any]

    # 元数据
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: float = field(default_factory=time.time)
    priority: EventPriority = EventPriority.NORMAL

    # 追踪信息
    session_id: Optional[str] = None
    trace_id: Optional[str] = None
    span_id: Optional[str] = None
    agent_name: Optional[str] = None

    # 调用链信息（用于构建调用树）
    call_id: Optional[str] = None          # 当前调用节点的ID
    parent_call_id: Optional[str] = None   # 父调用节点的ID

    # 用户交互
    requires_user_action: bool = False
    user_action_timeout: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典（用于序列化）"""
        return {
            "event_id": self.event_id,
            "type": self.type.value,
            "data": self.data,
            "timestamp": self.timestamp,
            "priority": self.priority.value,
            "session_id": self.session_id,
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "agent_name": self.agent_name,
            "call_id": self.call_id,
            "parent_call_id": self.parent_call_id,
            "requires_user_action": self.requires_user_action,
            "user_action_timeout": self.user_action_timeout
        }


# ==================== 事件订阅器 ====================

@dataclass
class Subscription:
    """事件订阅"""

    subscription_id: str
    event_types: List[EventType]
    handler: Callable[[Event], Any]
    is_async: bool
    filter_func: Optional[Callable[[Event], bool]] = None
    priority: int = 0  # 订阅者优先级（数字越大越先执行）


# ==================== 事件总线 ====================

class EventBus:
    """
    事件总线 - Agent系统的中央事件调度器

    特性：
    1. 支持同步/异步事件处理
    2. 支持事件过滤
    3. 支持订阅者优先级
    4. 支持事件持久化
    5. 支持用户许可等待机制
    """

    def __init__(self, enable_persistence: bool = False, max_history: int = 1000):
        """
        初始化事件总线

        Args:
            enable_persistence: 是否启用事件持久化（用于审计）
            max_history: 最大事件历史数量（防止内存泄漏）
        """
        self._subscriptions: Dict[EventType, List[Subscription]] = defaultdict(list)
        self._event_history: List[Event] = []  # 事件历史（内存中）
        self._enable_persistence = enable_persistence
        self._max_history = max_history  # ✨ 限制历史大小

        # 用户许可等待队列
        self._pending_approvals: Dict[str, asyncio.Future] = {}

        # 统计信息
        self._stats = {
            "total_events": 0,
            "events_by_type": defaultdict(int),
            "failed_events": 0
        }

        # ✨ 添加锁保护订阅操作
        self._lock = threading.RLock()

        logger.info(f"EventBus 初始化完成 (持久化: {enable_persistence}, 最大历史: {max_history})")

    def subscribe(
        self,
        event_types: List[EventType],
        handler: Callable[[Event], Any],
        filter_func: Optional[Callable[[Event], bool]] = None,
        priority: int = 0
    ) -> str:
        """
        订阅事件

        Args:
            event_types: 要订阅的事件类型列表
            handler: 事件处理函数（可以是同步或异步函数）
            filter_func: 事件过滤函数（返回True才处理）
            priority: 订阅者优先级（数字越大越先执行）

        Returns:
            subscription_id: 订阅ID（用于取消订阅）
        """
        subscription_id = str(uuid.uuid4())
        is_async = asyncio.iscoroutinefunction(handler)

        subscription = Subscription(
            subscription_id=subscription_id,
            event_types=event_types,
            handler=handler,
            is_async=is_async,
            filter_func=filter_func,
            priority=priority
        )

        # ✨ 使用锁保护订阅操作
        with self._lock:
            for event_type in event_types:
                self._subscriptions[event_type].append(subscription)
                # 按优先级排序（优先级高的先执行）
                self._subscriptions[event_type].sort(key=lambda s: s.priority, reverse=True)

        logger.info(f"新订阅: {subscription_id} → {[t.value for t in event_types]}")
        return subscription_id

    def unsubscribe(self, subscription_id: str):
        """取消订阅"""
        # ✨ 使用锁保护取消订阅操作
        with self._lock:
            for event_type in list(self._subscriptions.keys()):
                self._subscriptions[event_type] = [
                    s for s in self._subscriptions[event_type]
                    if s.subscription_id != subscription_id
                ]
        logger.info(f"取消订阅: {subscription_id}")

    def publish(self, event: Event):
        """
        发布事件（同步版本，用于兼容）

        Args:
            event: 事件对象
        """
        # 在异步环境中运行
        try:
            loop = asyncio.get_running_loop()
            asyncio.create_task(self.publish_async(event))
        except RuntimeError:
            # 如果不在异步环境中，使用同步方式
            self._publish_sync(event)

    def _publish_sync(self, event: Event):
        """同步发布事件（内部方法）"""
        self._stats["total_events"] += 1
        self._stats["events_by_type"][event.type] += 1

        # ✨ 持久化（限制历史大小）
        if self._enable_persistence:
            self._event_history.append(event)
            # 限制历史大小，防止内存泄漏
            if len(self._event_history) > self._max_history:
                self._event_history = self._event_history[-self._max_history:]

        # ✨ 获取订阅者（在锁内复制列表）
        with self._lock:
            subscriptions = list(self._subscriptions.get(event.type, []))

        logger.debug(f"发布事件: {event.type.value} (订阅者: {len(subscriptions)})")

        # 分发事件（在锁外执行，避免死锁）
        for subscription in subscriptions:
            try:
                # 应用过滤器
                if subscription.filter_func and not subscription.filter_func(event):
                    continue

                # 调用处理函数
                if subscription.is_async:
                    logger.warning(f"异步处理器在同步上下文中跳过: {subscription.subscription_id}")
                else:
                    subscription.handler(event)
            except Exception as e:
                self._stats["failed_events"] += 1
                logger.error(f"事件处理失败: {subscription.subscription_id}, 错误: {e}", exc_info=True)

    async def publish_async(self, event: Event):
        """
        异步发布事件

        Args:
            event: 事件对象
        """
        self._stats["total_events"] += 1
        self._stats["events_by_type"][event.type] += 1

        # ✨ 持久化（限制历史大小）
        if self._enable_persistence:
            self._event_history.append(event)
            # 限制历史大小，防止内存泄漏
            if len(self._event_history) > self._max_history:
                self._event_history = self._event_history[-self._max_history:]

        # ✨ 获取订阅者（在锁内复制列表）
        with self._lock:
            subscriptions = list(self._subscriptions.get(event.type, []))

        logger.debug(f"发布事件: {event.type.value} (订阅者: {len(subscriptions)})")

        # 分发事件（在锁外执行，避免死锁）
        tasks = []
        for subscription in subscriptions:
            try:
                # 应用过滤器
                if subscription.filter_func and not subscription.filter_func(event):
                    continue

                # 调用处理函数
                if subscription.is_async:
                    tasks.append(self._safe_async_call(subscription, event))
                else:
                    # 同步函数在线程池中执行
                    loop = asyncio.get_running_loop()
                    tasks.append(loop.run_in_executor(None, subscription.handler, event))
            except Exception as e:
                self._stats["failed_events"] += 1
                logger.error(f"事件处理失败: {subscription.subscription_id}, 错误: {e}", exc_info=True)

        # 并发执行所有处理器
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _safe_async_call(self, subscription: Subscription, event: Event):
        """安全的异步调用（捕获异常）"""
        try:
            await subscription.handler(event)
        except Exception as e:
            self._stats["failed_events"] += 1
            logger.error(f"异步事件处理失败: {subscription.subscription_id}, 错误: {e}", exc_info=True)

    # ==================== 用户许可机制 ====================

    async def request_user_approval(
        self,
        agent_name: str,
        action_description: str,
        timeout: float = 60.0,
        session_id: Optional[str] = None,
        trace_id: Optional[str] = None
    ) -> bool:
        """
        请求用户许可（等待用户响应）

        Args:
            agent_name: Agent名称
            action_description: 动作描述
            timeout: 超时时间（秒）
            session_id: 会话ID
            trace_id: 追踪ID

        Returns:
            bool: True=用户同意, False=用户拒绝或超时
        """
        approval_id = str(uuid.uuid4())

        # 创建Future用于等待用户响应
        future = asyncio.get_running_loop().create_future()
        self._pending_approvals[approval_id] = future

        # 发布用户许可请求事件
        event = Event(
            type=EventType.USER_APPROVAL_REQUIRED,
            data={
                "approval_id": approval_id,
                "agent_name": agent_name,
                "action_description": action_description,
                "timeout": timeout
            },
            session_id=session_id,
            trace_id=trace_id,
            agent_name=agent_name,
            requires_user_action=True,
            user_action_timeout=timeout
        )

        await self.publish_async(event)

        logger.info(f"[{agent_name}] 等待用户许可: {action_description} (超时: {timeout}s)")

        # 等待用户响应（带超时）
        try:
            result = await asyncio.wait_for(future, timeout=timeout)
            logger.info(f"[{agent_name}] 用户许可结果: {'同意' if result else '拒绝'}")
            return result
        except asyncio.TimeoutError:
            logger.warning(f"[{agent_name}] 用户许可超时")
            # 清理
            if approval_id in self._pending_approvals:
                del self._pending_approvals[approval_id]
            return False

    def respond_to_approval(self, approval_id: str, approved: bool):
        """
        响应用户许可请求

        Args:
            approval_id: 许可请求ID
            approved: True=同意, False=拒绝
        """
        if approval_id not in self._pending_approvals:
            logger.warning(f"未找到许可请求: {approval_id}")
            return

        future = self._pending_approvals.pop(approval_id)
        if not future.done():
            future.set_result(approved)

        # 发布用户响应事件
        event_type = EventType.USER_APPROVAL_GRANTED if approved else EventType.USER_APPROVAL_DENIED
        event = Event(
            type=event_type,
            data={"approval_id": approval_id, "approved": approved}
        )
        self.publish(event)

        logger.info(f"用户许可响应: {approval_id} → {'同意' if approved else '拒绝'}")

    # ==================== 工具方法 ====================

    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息"""
        return {
            "total_events": self._stats["total_events"],
            "events_by_type": dict(self._stats["events_by_type"]),
            "failed_events": self._stats["failed_events"],
            "active_subscriptions": sum(len(subs) for subs in self._subscriptions.values()),
            "pending_approvals": len(self._pending_approvals)
        }

    def get_event_history(
        self,
        event_types: Optional[List[EventType]] = None,
        session_id: Optional[str] = None,
        limit: int = 100
    ) -> List[Event]:
        """
        获取事件历史

        Args:
            event_types: 过滤事件类型
            session_id: 过滤会话ID
            limit: 最大返回数量

        Returns:
            事件列表
        """
        filtered_events = self._event_history

        if event_types:
            filtered_events = [e for e in filtered_events if e.type in event_types]

        if session_id:
            filtered_events = [e for e in filtered_events if e.session_id == session_id]

        return filtered_events[-limit:]

    def clear_history(self):
        """清空事件历史"""
        self._event_history.clear()
        logger.info("事件历史已清空")


# ==================== 全局事件总线 ====================

_global_event_bus: Optional[EventBus] = None


def get_event_bus(enable_persistence: bool = False) -> EventBus:
    """
    获取全局事件总线（单例）

    Args:
        enable_persistence: 是否启用事件持久化

    Returns:
        EventBus实例
    """
    global _global_event_bus
    if _global_event_bus is None:
        _global_event_bus = EventBus(enable_persistence=enable_persistence)
    return _global_event_bus


# ==================== 上下文变量 ====================

# 当前会话的事件总线（用于请求级隔离）
_current_event_bus: ContextVar[Optional[EventBus]] = ContextVar('current_event_bus', default=None)


def set_current_event_bus(event_bus: EventBus):
    """设置当前请求的事件总线"""
    _current_event_bus.set(event_bus)


def get_current_event_bus() -> Optional[EventBus]:
    """获取当前请求的事件总线"""
    return _current_event_bus.get() or get_event_bus()
