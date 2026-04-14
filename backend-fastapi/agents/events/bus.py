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
import itertools
import logging
import time
import uuid
import threading  # ✨ 添加 threading 导入
from typing import Dict, List, Callable, Any, Optional, Coroutine
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from collections import defaultdict, deque
from contextvars import ContextVar

from runtime.dependencies import get_runtime_dependency

logger = logging.getLogger(__name__)


def _normalize_event_type(event_type: "str | EventType") -> str:
    return event_type.value if hasattr(event_type, 'value') else str(event_type)


def _format_subscription_event_types(event_types: "List[str | EventType]") -> str:
    formatted = [_normalize_event_type(t) for t in event_types]
    if len(formatted) > 8:
        preview = ', '.join(formatted[:3])
        return f'[{preview}, ...] (total={len(formatted)})'
    return str(formatted)


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
    AGENT_RETRY_SCHEDULED = "agent.retry_scheduled"

    # 流式意图事件
    INTENT_DELTA = "agent.intent_delta"          # intent 增量内容
    INTENT_COMPLETE = "agent.intent_complete"    # intent 完成

    # 调用生命周期（Agent）
    CALL_AGENT_START = "call.agent.start"
    CALL_AGENT_END = "call.agent.end"

    # 调用生命周期（Tool）
    CALL_TOOL_START = "call.tool.start"
    CALL_TOOL_END = "call.tool.end"

    # 规范化执行步骤
    EXECUTION_STEP = "execution.step"

    # 流式输出事件
    CHUNK = "output.chunk"
    FINAL_ANSWER = "output.final_answer"
    MESSAGE_SAVED = "output.message_saved"  # 消息持久化完成，携带 id/seq 供前端补全

    # 可视化事件
    CHART_GENERATED = "visualization.chart"  # DEPRECATED: 仅为旧 DB 记录保留
    MAP_GENERATED = "visualization.map"  # DEPRECATED: 仅为旧 DB 记录保留

    # 用户交互事件 (Human-in-the-Loop)
    USER_APPROVAL_REQUIRED = "user.approval_required"
    USER_APPROVAL_GRANTED = "user.approval_granted"
    USER_APPROVAL_DENIED = "user.approval_denied"
    USER_INPUT_REQUIRED = "user.input_required"
    USER_INTERRUPT = "user.interrupt"
    USER_FEEDBACK = "user.feedback"

    # ReAct 中间过程事件
    REACT_INTERMEDIATE = "react.intermediate"

    # 上下文压缩事件
    COMPRESSION_START = "context.compression_start"
    COMPRESSION_SUMMARY = "context.compression_summary"

    # 上下文用量事件
    CONTEXT_USAGE = "context.usage"

    # 代码执行事件（PTC）
    CODE_EXECUTION_START = "code.execution.start"
    CODE_EXECUTION_END = "code.execution.end"

    # Hook 生命周期事件
    HOOK_STARTED = "hook.started"
    HOOK_PROGRESS = "hook.progress"
    HOOK_RESPONSE = "hook.response"
    HOOK_ERROR = "hook.error"

    # 工具执行进度（长命令实时上报）
    TOOL_PROGRESS = "tool.progress"

    # 后台任务完成通知
    BACKGROUND_TASK_COMPLETED = "background.task.completed"

    # 系统事件
    SESSION_END = "session.end"
    ERROR = "system.error"

    # 守护 Agent 系统事件
    DAEMON_ADAPTER_STATUS = "daemon.adapter.status"
    DAEMON_ADAPTER_ERROR = "daemon.adapter.error"
    DAEMON_CRON_TRIGGERED = "daemon.cron.triggered"
    DAEMON_CRON_COMPLETED = "daemon.cron.completed"
    DAEMON_MESSAGE_RECEIVED = "daemon.message.received"
    DAEMON_MESSAGE_SENT = "daemon.message.sent"


class EventPriority(int, Enum):
    """事件优先级"""
    LOW = 0
    NORMAL = 1
    HIGH = 2
    CRITICAL = 3


# ── 全局事件序号 ──────────────────────────────────────────
_global_seq_counter = itertools.count(1)

# ── 关键事件类型（背压保护时不可丢弃）────────────────────
CRITICAL_EVENT_TYPES = frozenset({
    EventType.RUN_START, EventType.RUN_END,
    EventType.AGENT_START, EventType.AGENT_END, EventType.AGENT_ERROR,
    EventType.CALL_AGENT_START, EventType.CALL_AGENT_END,
    EventType.CALL_TOOL_START, EventType.CALL_TOOL_END,
    EventType.EXECUTION_STEP,
    EventType.INTENT_COMPLETE,
    EventType.SESSION_END, EventType.USER_INTERRUPT,
    EventType.FINAL_ANSWER, EventType.MESSAGE_SAVED,
    EventType.USER_APPROVAL_REQUIRED, EventType.USER_INPUT_REQUIRED,
})


@dataclass
class Event:
    """事件数据结构"""

    # 基础字段
    type: "str | EventType"
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

    # 全局递增序号
    sequence_number: int = field(default_factory=lambda: next(_global_seq_counter))

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典（用于序列化）"""
        return {
            "event_id": self.event_id,
            "type": self.type.value if hasattr(self.type, 'value') else self.type,
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
            "user_action_timeout": self.user_action_timeout,
            "seq": self.sequence_number,
        }


# ==================== 事件订阅器 ====================

@dataclass
class Subscription:
    """事件订阅"""

    subscription_id: str
    event_types: tuple[str, ...]
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
        self._subscriptions_by_id: Dict[str, Subscription] = {}
        self._subscription_ids_by_event: Dict[str, List[str]] = defaultdict(list)
        self._event_history: deque[Event] = deque(maxlen=max_history)
        self._enable_persistence = enable_persistence
        self._max_history = max_history

        # 用户许可等待队列
        self._pending_approvals: Dict[str, asyncio.Future] = {}

        # 统计信息
        self._stats = {
            "total_events": 0,
            "events_by_type": defaultdict(int),
            "failed_events": 0,
        }

        self._lock = threading.RLock()

        logger.debug(f"EventBus 初始化完成 (持久化: {enable_persistence}, 最大历史: {max_history})")

    def subscribe(
        self,
        event_types: "List[str | EventType]",
        handler: Callable[[Event], Any],
        filter_func: Optional[Callable[[Event], bool]] = None,
        priority: int = 0,
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
        normalized_types = tuple(_normalize_event_type(event_type) for event_type in event_types)
        subscription = Subscription(
            subscription_id=subscription_id,
            event_types=normalized_types,
            handler=handler,
            is_async=asyncio.iscoroutinefunction(handler),
            filter_func=filter_func,
            priority=priority,
        )

        with self._lock:
            self._subscriptions_by_id[subscription_id] = subscription
            for event_type in normalized_types:
                event_subscription_ids = self._subscription_ids_by_event[event_type]
                event_subscription_ids.append(subscription_id)
                event_subscription_ids.sort(
                    key=lambda sid: self._subscriptions_by_id[sid].priority,
                    reverse=True,
                )

        logger.debug("新订阅: %s → %s", subscription_id, _format_subscription_event_types(list(normalized_types)))
        return subscription_id

    def unsubscribe(self, subscription_id: str):
        """取消订阅"""
        with self._lock:
            subscription = self._subscriptions_by_id.pop(subscription_id, None)
            if subscription is None:
                logger.debug(f"取消订阅: {subscription_id} (ignored, not found)")
                return

            for event_type in subscription.event_types:
                event_subscription_ids = self._subscription_ids_by_event.get(event_type)
                if not event_subscription_ids:
                    continue
                self._subscription_ids_by_event[event_type] = [
                    sid for sid in event_subscription_ids if sid != subscription_id
                ]
                if not self._subscription_ids_by_event[event_type]:
                    del self._subscription_ids_by_event[event_type]
        logger.debug(f"取消订阅: {subscription_id}")

    def publish(self, event: Event):
        """
        发布事件（同步版本，用于兼容）

        Args:
            event: 事件对象
        """
        self._record_event(event)
        self._handle_run_end_side_effect(event)
        subscriptions = self._collect_subscriptions(event.type)
        event_type = _normalize_event_type(event.type)

        logger.debug(f"发布事件: {event_type} (订阅者: {len(subscriptions)})")

        for subscription in subscriptions:
            if not self._should_deliver(subscription, event):
                continue
            try:
                if subscription.is_async:
                    logger.warning(f"异步处理器在同步上下文中跳过: {subscription.subscription_id}")
                    continue
                subscription.handler(event)
            except Exception as e:
                self._record_failed_delivery(subscription.subscription_id, e, "事件处理失败")

    async def publish_async(self, event: Event):
        """
        异步发布事件

        Args:
            event: 事件对象
        """
        self._record_event(event)
        self._handle_run_end_side_effect(event)
        subscriptions = self._collect_subscriptions(event.type)
        event_type = _normalize_event_type(event.type)

        logger.debug(f"发布事件: {event_type} (订阅者: {len(subscriptions)})")

        for subscription in subscriptions:
            if not self._should_deliver(subscription, event):
                continue
            if subscription.is_async:
                try:
                    await subscription.handler(event)
                except Exception as e:
                    self._record_failed_delivery(subscription.subscription_id, e, "异步事件处理失败")
                continue
            try:
                subscription.handler(event)
            except Exception as e:
                self._record_failed_delivery(subscription.subscription_id, e, "事件处理失败")

    def _record_event(self, event: Event):
        event_type = _normalize_event_type(event.type)
        self._stats["total_events"] += 1
        self._stats["events_by_type"][event_type] += 1
        if self._enable_persistence:
            self._event_history.append(event)

    def _handle_run_end_side_effect(self, event: Event):
        if _normalize_event_type(event.type) != EventType.RUN_END.value:
            return
        try:
            from agents.events.session_manager import get_session_manager
            run_id = (event.data or {}).get('run_id')
            if run_id:
                get_session_manager().mark_run_ended(run_id)
        except Exception:
            pass

    def _collect_subscriptions(self, event_type: "str | EventType") -> List[Subscription]:
        normalized_type = _normalize_event_type(event_type)
        with self._lock:
            subscription_ids = list(self._subscription_ids_by_event.get(normalized_type, []))
            return [
                self._subscriptions_by_id[sid]
                for sid in subscription_ids
                if sid in self._subscriptions_by_id
            ]

    def _should_deliver(self, subscription: Subscription, event: Event) -> bool:
        if subscription.filter_func is None:
            return True
        return bool(subscription.filter_func(event))

    def _record_failed_delivery(self, subscription_id: str, error: Exception, message: str):
        self._stats["failed_events"] += 1
        logger.error(f"{message}: {subscription_id}, 错误: {error}", exc_info=True)

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

        logger.debug(f"[{agent_name}] 等待用户许可: {action_description} (超时: {timeout}s)")

        # 等待用户响应（带超时）
        try:
            result = await asyncio.wait_for(future, timeout=timeout)
            logger.debug(f"[{agent_name}] 用户许可结果: {'同意' if result else '拒绝'}")
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

        logger.debug(f"用户许可响应: {approval_id} → {'同意' if approved else '拒绝'}")

    # ==================== 工具方法 ====================

    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息"""
        return {
            "total_events": self._stats["total_events"],
            "events_by_type": dict(self._stats["events_by_type"]),
            "failed_events": self._stats["failed_events"],
            "active_subscriptions": len(self._subscriptions_by_id),
            "pending_approvals": len(self._pending_approvals)
        }

    def get_event_history(
        self,
        event_types: "Optional[List[str | EventType]]" = None,
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
        filtered_events: List[Event] = list(self._event_history)

        if event_types:
            normalized_types = {_normalize_event_type(event_type) for event_type in event_types}
            filtered_events = [
                event for event in filtered_events
                if _normalize_event_type(event.type) in normalized_types
            ]

        if session_id:
            filtered_events = [event for event in filtered_events if event.session_id == session_id]

        return filtered_events[-limit:]

    def clear_history(self):
        """清空事件历史"""
        self._event_history.clear()
        logger.debug("事件历史已清空")


# ==================== 全局事件总线 ====================

def get_event_bus(enable_persistence: bool = False) -> EventBus:
    """
    获取全局事件总线（单例）

    Args:
        enable_persistence: 是否启用事件持久化

    Returns:
        EventBus实例
    """
    return get_runtime_dependency(
        container_resolver=lambda c: c.get_event_bus(
            enable_persistence=enable_persistence,
        ),
    )


# ==================== 上下文变量 ====================

# 当前会话的事件总线（用于请求级隔离）
_current_event_bus: ContextVar[Optional[EventBus]] = ContextVar('current_event_bus', default=None)


def set_current_event_bus(event_bus: EventBus):
    """设置当前请求的事件总线"""
    _current_event_bus.set(event_bus)


def get_current_event_bus() -> Optional[EventBus]:
    """获取当前请求的事件总线"""
    return _current_event_bus.get() or get_event_bus()
