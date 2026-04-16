# -*- coding: utf-8 -*-
"""
SSE适配器 - 将事件总线的事件转换为Server-Sent Events流

职责：
1. 订阅事件总线的事件
2. 将事件格式化为SSE格式
3. 通过生成器函数流式输出
"""

import json
import logging
from typing import Optional, Generator
from queue import Queue, Empty
import time

from .bus import EventBus, Event, EventType, CRITICAL_EVENT_TYPES

logger = logging.getLogger(__name__)


def is_critical_event_type(event_type: str | EventType) -> bool:
    """Accept both raw strings and EventType enums for backpressure protection."""
    if event_type in CRITICAL_EVENT_TYPES:
        return True
    if isinstance(event_type, str):
        return any(event_type == critical.value for critical in CRITICAL_EVENT_TYPES)
    return False


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


def event_to_client_dict(event: "Event") -> dict:
    """将 Event 对象转换为客户端字典格式（SSE 和 WebSocket 共用）。"""
    d = {
        "type": event.type.value,
        "event_id": event.event_id,
        "timestamp": event.timestamp,
        "priority": event.priority.value,
        "session_id": event.session_id,
        "trace_id": event.trace_id,
        "span_id": event.span_id,
        "agent_name": event.agent_name,
        "call_id": event.call_id,
        "parent_call_id": event.parent_call_id,
        "data": build_client_event_data(event.type.value, event.data),
        "requires_user_action": event.requires_user_action,
        "user_action_timeout": event.user_action_timeout,
        "seq": event.sequence_number,
    }
    return {k: v for k, v in d.items() if v is not None}


class SSEAdapter:
    """
    SSE适配器 - 将事件总线桥接到前端

    使用方式:
        adapter = SSEAdapter(event_bus, session_id="abc123")
        for sse_data in adapter.stream_sync():
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

        # 事件队列 - 有界队列，背压保护
        self._event_queue: Queue = Queue(maxsize=buffer_size)

        # 订阅ID
        self._subscription_id: Optional[str] = None

        # 是否已停止
        self._stopped = False
        self._primary_agent_name: Optional[str] = None

        # 背压统计
        self._dropped_count: int = 0
        self._last_seq: int = 0

        # 重连去重：跳过 sequence_number <= 此值的事件（已通过历史回放发送）
        self.skip_before_seq: int = 0
        self.completed_normally: bool = False
        self.terminal_event_type: Optional[str] = None

    def start(self):
        """开始监听事件"""
        if self._subscription_id:
            logger.warning(f"[SSEAdapter] 已经启动，跳过重复启动")
            return

        self.completed_normally = False
        self.terminal_event_type = None
        self._stopped = False

        # 订阅所有事件类型
        self._subscription_id = self.event_bus.subscribe(
            event_types=list(EventType),
            handler=self._handle_event,
            filter_func=self._filter_event
        )

        logger.info(f"[SSEAdapter] 已启动 (session: {self.session_id})")

    def stop(self):
        """停止监听事件"""
        if self._stopped:
            return

        self._stopped = True

        if self._subscription_id:
            self.event_bus.unsubscribe(self._subscription_id)
            self._subscription_id = None

        # 放入哨兵值唤醒可能阻塞在 get() 的 stream_sync
        try:
            self._event_queue.put_nowait(None)
        except Exception:
            pass
        logger.info(f"[SSEAdapter] 已停止 (session: {self.session_id})")

    def _terminal_reason(self, event: Event) -> Optional[str]:
        if event.type == EventType.USER_INTERRUPT:
            return event.type.value
        if event.type == EventType.RUN_END:
            return event.type.value
        if event.type == EventType.SESSION_END:
            return event.type.value
        return None

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
        事件处理器 - 分级写入：关键事件保证入队，非关键事件队满时丢弃。
        """
        is_critical = is_critical_event_type(event.type)

        try:
            try:
                self._event_queue.put_nowait(event)
            except Exception:
                if is_critical:
                    self._evict_non_critical()
                    try:
                        self._event_queue.put_nowait(event)
                    except Exception:
                        logger.error(f"[SSEAdapter] 关键事件入队失败（队列全为关键事件）: {event.type.value}")
                else:
                    self._dropped_count += 1
                    logger.warning(f"[SSEAdapter] 非关键事件丢弃 (dropped={self._dropped_count}): {event.type.value}")

        except Exception as e:
            logger.error(f"[SSEAdapter] 处理事件失败: {e}")

    def _evict_non_critical(self):
        """从队列头部驱逐非关键事件，腾出空间。"""
        evicted = 0
        temp = []
        while not self._event_queue.empty():
            try:
                item = self._event_queue.get_nowait()
                if is_critical_event_type(item.type):
                    temp.append(item)
                else:
                    evicted += 1
                    self._dropped_count += 1
                    break  # 只需腾出一个位置
            except Empty:
                break
        for item in temp:
            try:
                self._event_queue.put_nowait(item)
            except Exception:
                break
        if evicted:
            logger.debug(f"[SSEAdapter] 队列驱逐 {evicted} 个非关键事件")

    def stream_sync(self) -> Generator[str, None, None]:
        """
        SSE流式输出生成器

        Yields:
            str: SSE格式的数据（"data: {...}\\n\\n"）
        """
        try:
            last_heartbeat = time.time()

            while not self._stopped:
                try:
                    event = self._event_queue.get(timeout=1.0)
                    if event is None:  # 哨兵值，stop() 被调用
                        break

                    # 重连去重：跳过已通过历史回放发送的事件
                    if self.skip_before_seq and event.sequence_number <= self.skip_before_seq:
                        continue

                    terminal_reason = self._terminal_reason(event)
                    if terminal_reason:
                        self.completed_normally = True
                        self.terminal_event_type = terminal_reason

                    # 所有事件直接转发，无假流式处理
                    sse_data = self._format_sse(event)
                    yield sse_data

                    last_heartbeat = time.time()
                    self._last_seq = event.sequence_number

                    if terminal_reason:
                        logger.info(f"[SSEAdapter] 检测到终止事件 ({terminal_reason})，停止流式输出")
                        break

                except Empty:
                    # 超时：发送心跳
                    now = time.time()
                    if now - last_heartbeat >= self.heartbeat_interval:
                        yield self._heartbeat()
                        last_heartbeat = now

                except Exception as e:
                    logger.error(f"[SSEAdapter] 流式输出错误: {e}", exc_info=True)

        finally:
            self.stop()

    def _format_sse(self, event: Event) -> str:
        """将事件格式化为SSE格式（纯序列化，不含业务逻辑）"""
        full_event = event_to_client_dict(event)
        json_data = json.dumps(full_event, ensure_ascii=False)
        return f"data: {json_data}\n\n"

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
