# -*- coding: utf-8 -*-
"""
SSE适配器 - 将事件总线的事件转换为Server-Sent Events流

职责：
1. 订阅事件总线的事件
2. 将事件格式化为SSE格式
3. 通过生成器函数流式输出
"""

import asyncio
import json
import logging
from typing import AsyncGenerator, Optional, List, Generator
from queue import Queue, Empty
import time
import threading

from .bus import EventBus, Event, EventType, CRITICAL_EVENT_TYPES

logger = logging.getLogger(__name__)


def build_client_event_data(event_type: str, data: Optional[dict]) -> dict:
    """Build a client-facing event payload while preserving tool result semantics."""
    payload = dict(data or {})
    if event_type == EventType.CALL_TOOL_END.value:
        preview = payload.get("result_preview")
        if preview is None:
            preview = payload.get("result")
        if preview is not None:
            payload["result_preview"] = preview
            payload["result"] = preview
        if "raw_result_available" not in payload:
            payload["raw_result_available"] = payload.get("raw_result") is not None
    return payload


class SSEAdapter:
    """
    SSE适配器 - 将事件总线桥接到前端

    使用方式:
        adapter = SSEAdapter(event_bus, session_id="abc123")
        async for sse_data in adapter.stream():
            yield sse_data
    """

    def __init__(
        self,
        event_bus: EventBus,
        session_id: str,
        buffer_size: int = 100,
        heartbeat_interval: float = 15.0,
    ):
        """
        初始化SSE适配器（纯转发管道，不含业务逻辑）

        Args:
            event_bus: 事件总线实例
            session_id: 会话ID（仅接收该会话的事件）
            buffer_size: 事件缓冲区大小
            heartbeat_interval: 心跳间隔（秒）
        """
        self.event_bus = event_bus
        self.session_id = session_id
        self.buffer_size = buffer_size
        self.heartbeat_interval = heartbeat_interval

        # 事件队列（异步）- 有界队列，背压保护
        self._event_queue: asyncio.Queue = asyncio.Queue(maxsize=buffer_size)

        # 事件队列（同步）- 有界队列，背压保护
        self._sync_event_queue: Queue = Queue(maxsize=buffer_size)

        # 订阅ID
        self._subscription_id: Optional[str] = None

        # 是否已停止
        self._stopped = False
        self._primary_agent_name: Optional[str] = None

        # 背压统计
        self._dropped_count: int = 0
        self._last_seq: int = 0

    def start(self):
        """开始监听事件"""
        if self._subscription_id:
            logger.warning(f"[SSEAdapter] 已经启动，跳过重复启动")
            return

        # 订阅所有事件类型
        self._subscription_id = self.event_bus.subscribe(
            event_types=list(EventType),
            handler=self._handle_event,
            filter_func=self._filter_event
        )

        logger.info(f"[SSEAdapter] 已启动 (session: {self.session_id})")

    def stop(self):
        """停止监听事件"""
        if self._subscription_id:
            self.event_bus.unsubscribe(self._subscription_id)
            self._subscription_id = None

        self._stopped = True
        logger.info(f"[SSEAdapter] 已停止 (session: {self.session_id})")

    def _filter_event(self, event: Event) -> bool:
        """
        事件过滤器：仅接收当前会话的事件

        Args:
            event: 事件对象

        Returns:
            bool: True=接收事件, False=忽略事件
        """
        # SSE 连接必须严格按 session 隔离。
        # 漏带 session_id 的事件不能广播给所有会话，否则多个并发会话会串流。
        return bool(event.session_id) and event.session_id == self.session_id

    def _handle_event(self, event: Event):
        """
        事件处理器（同步版本）- 分级写入：关键事件保证入队，非关键事件队满时丢弃。
        """
        is_critical = event.type in CRITICAL_EVENT_TYPES

        try:
            # 放入异步队列
            try:
                self._event_queue.put_nowait(event)
            except asyncio.QueueFull:
                if is_critical:
                    self._evict_non_critical_async()
                    try:
                        self._event_queue.put_nowait(event)
                    except asyncio.QueueFull:
                        logger.error(f"[SSEAdapter] 关键事件入队失败（队列全为关键事件）: {event.type.value}")
                else:
                    self._dropped_count += 1
                    logger.warning(f"[SSEAdapter] 非关键事件丢弃 (dropped={self._dropped_count}): {event.type.value}")

            # 放入同步队列（用于非async环境）
            try:
                self._sync_event_queue.put_nowait(event)
            except Exception:
                if is_critical:
                    self._evict_non_critical_sync()
                    try:
                        self._sync_event_queue.put_nowait(event)
                    except Exception:
                        logger.error(f"[SSEAdapter] 关键事件同步入队失败: {event.type.value}")
                else:
                    # 已在异步队列统计过 dropped_count，此处不重复计数
                    pass

        except Exception as e:
            logger.error(f"[SSEAdapter] 处理事件失败: {e}")

    def _evict_non_critical_async(self):
        """从异步队列头部驱逐非关键事件，腾出空间。"""
        evicted = 0
        temp = []
        while not self._event_queue.empty():
            try:
                item = self._event_queue.get_nowait()
                if item.type in CRITICAL_EVENT_TYPES:
                    temp.append(item)
                else:
                    evicted += 1
                    self._dropped_count += 1
                    break  # 只需腾出一个位置
            except asyncio.QueueEmpty:
                break
        # 把取出的关键事件放回
        for item in temp:
            try:
                self._event_queue.put_nowait(item)
            except asyncio.QueueFull:
                break
        if evicted:
            logger.debug(f"[SSEAdapter] 异步队列驱逐 {evicted} 个非关键事件")

    def _evict_non_critical_sync(self):
        """从同步队列头部驱逐非关键事件，腾出空间。"""
        evicted = 0
        temp = []
        while not self._sync_event_queue.empty():
            try:
                item = self._sync_event_queue.get_nowait()
                if item.type in CRITICAL_EVENT_TYPES:
                    temp.append(item)
                else:
                    evicted += 1
                    break
            except Empty:
                break
        for item in temp:
            try:
                self._sync_event_queue.put_nowait(item)
            except Exception:
                break
        if evicted:
            logger.debug(f"[SSEAdapter] 同步队列驱逐 {evicted} 个非关键事件")

    async def stream(self) -> AsyncGenerator[str, None]:
        """
        SSE流式输出生成器

        Yields:
            str: SSE格式的数据（"data: {...}\\n\\n"）
        """
        self.start()

        try:
            last_heartbeat = time.time()

            while not self._stopped:
                try:
                    # 从队列获取事件（带超时）
                    event = await asyncio.wait_for(
                        self._event_queue.get(),
                        timeout=1.0
                    )

                    # 所有事件直接转发，无假流式处理
                    sse_data = self._format_sse(event)
                    yield sse_data

                    last_heartbeat = time.time()
                    self._last_seq = event.sequence_number

                    # ✨ 检测结束事件，自动停止流
                    # 优先级 0: 用户中断
                    if event.type == EventType.USER_INTERRUPT:
                        logger.info(f"[SSEAdapter] 检测到用户中断事件，停止流式输出")
                        break

            # 优先级 1: Run 结束 (Orchestrator V2)
                    if event.type == EventType.RUN_END:
                        logger.info(f"[SSEAdapter] 检测到 Run 结束事件 ({event.type.value})，停止流式输出")
                        break
                    # 超时：发送心跳
                    now = time.time()
                    if now - last_heartbeat >= self.heartbeat_interval:
                        yield self._heartbeat()
                        last_heartbeat = now

                except Exception as e:
                    logger.error(f"[SSEAdapter] 流式输出错误: {e}", exc_info=True)

        finally:
            self.stop()

    def stream_sync(self) -> Generator[str, None, None]:
        """
        SSE流式输出生成器（同步版本，用于Flask等非async环境）

        Yields:
            str: SSE格式的数据（"data: {...}\\n\\n"）
        """
        self.start()

        try:
            last_heartbeat = time.time()

            while not self._stopped:
                try:
                    # 从同步队列获取事件（带超时）
                    event = self._sync_event_queue.get(timeout=1.0)

                    # 所有事件直接转发，无假流式处理
                    sse_data = self._format_sse(event)
                    yield sse_data

                    last_heartbeat = time.time()
                    self._last_seq = event.sequence_number

                    # ✨ 检测结束事件，自动停止流
                    # 优先级 0: 用户中断
                    if event.type == EventType.USER_INTERRUPT:
                        logger.info(f"[SSEAdapter] 检测到用户中断事件，停止流式输出")
                        break

            # 优先级 1: Run 结束 (Orchestrator V2)
                    if event.type == EventType.RUN_END:
                        logger.info(f"[SSEAdapter] 检测到 Run 结束事件 ({event.type.value})，停止流式输出")
                        break

                    # 优先级 2: Session 结束 (通用)
                    if event.type == EventType.SESSION_END:
                        logger.info(f"[SSEAdapter] 检测到 Session 结束事件 ({event.type.value})，停止流式输出")
                        break

                    # 优先级 3: 主 Agent 结束 (兼容旧模式)
                    if event.type == EventType.AGENT_START and self._primary_agent_name is None:
                        self._primary_agent_name = event.agent_name

                    if self._primary_agent_name and event.type == EventType.AGENT_END and event.agent_name == self._primary_agent_name:
                        logger.info(f"[SSEAdapter] 检测到主 Agent 结束事件 ({event.type.value})，停止流式输出")
                        break

                except Empty:
                    # 超时：发送心跳
                    now = time.time()
                    if now - last_heartbeat >= self.heartbeat_interval:
                        yield self._heartbeat()
                        last_heartbeat = now

                except Exception as e:
                    logger.error(f"[SSEAdapter] 同步流式输出错误: {e}", exc_info=True)

        finally:
            self.stop()

    def _format_sse(self, event: Event) -> str:
        """将事件格式化为SSE格式（纯序列化，不含业务逻辑）"""
        full_event = self._to_full_event_dict(event)
        json_data = json.dumps(full_event, ensure_ascii=False)
        return f"data: {json_data}\n\n"

    def _to_full_event_dict(self, event: Event) -> dict:
        """
        将 Event 对象转换为完整的字典格式（保留所有信息）

        完整格式（新版）：
            {
                "type": "agent_start",
                "event_id": "uuid...",
                "timestamp": 123456.789,
                "priority": "normal",
                "session_id": "abc123",
                "trace_id": "xyz789",
                "span_id": "span123",
                "agent_name": "orchestrator_agent",
                "data": {
                    "task": "...",
                    "metadata": {}
                },
                "requires_user_action": false,
                "user_action_timeout": null
            }

        Args:
            event: Event 对象

        Returns:
            dict: 完整的事件字典
        """
        return {
            # 事件类型（使用 EventType 的 value）
            "type": event.type.value,

            # 事件元数据
            "event_id": event.event_id,
            "timestamp": event.timestamp,
            "priority": event.priority.value,

            # 会话和追踪信息
            "session_id": event.session_id,
            "trace_id": event.trace_id,
            "span_id": event.span_id,

            # Agent 信息
            "agent_name": event.agent_name,
            "call_id": event.call_id,
            "parent_call_id": event.parent_call_id,

            # 事件数据（完整保留）
            "data": build_client_event_data(event.type.value, event.data),

            # 用户交互
            "requires_user_action": event.requires_user_action,
            "user_action_timeout": event.user_action_timeout,

            # 事件序号
            "seq": event.sequence_number,
        }

    def _heartbeat(self) -> str:
        """
        生成心跳SSE

        Returns:
            str: 心跳SSE数据
        """
        heartbeat_data = {
            "type": "heartbeat",
            "timestamp": time.time(),
            "last_seq": self._last_seq,
            "dropped_count": self._dropped_count,
        }
        json_data = json.dumps(heartbeat_data, ensure_ascii=False)
        return f"data: {json_data}\n\n"


# ==================== 便捷函数 ====================

async def stream_events_to_sse(
    event_bus: EventBus,
    session_id: str
) -> AsyncGenerator[str, None]:
    """
    便捷函数：将事件总线流式输出为SSE

    Args:
        event_bus: 事件总线实例
        session_id: 会话ID

    Yields:
        str: SSE格式的数据
    """
    adapter = SSEAdapter(event_bus=event_bus, session_id=session_id)

    async for sse_data in adapter.stream():
        yield sse_data
