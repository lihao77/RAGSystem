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

from .event_bus import EventBus, Event, EventType

logger = logging.getLogger(__name__)


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
        enable_final_answer_streaming: bool = True,  # ✨ 新增：是否启用 final_answer 流式输出
        chunk_size: int = 5  # ✨ 新增：流式输出的 chunk 大小
    ):
        """
        初始化SSE适配器

        Args:
            event_bus: 事件总线实例
            session_id: 会话ID（仅接收该会话的事件）
            buffer_size: 事件缓冲区大小
            heartbeat_interval: 心跳间隔（秒）
            enable_final_answer_streaming: 是否将 final_answer 拆分为 chunks 流式输出
            chunk_size: 每个 chunk 的字符数
        """
        self.event_bus = event_bus
        self.session_id = session_id
        self.buffer_size = buffer_size
        self.heartbeat_interval = heartbeat_interval
        self.enable_final_answer_streaming = enable_final_answer_streaming
        self.chunk_size = chunk_size

        # 事件队列（异步）
        self._event_queue: asyncio.Queue = asyncio.Queue(maxsize=buffer_size)

        # 事件队列（同步）- 用于非async环境
        self._sync_event_queue: Queue = Queue(maxsize=buffer_size)

        # 订阅ID
        self._subscription_id: Optional[str] = None

        # 是否已停止
        self._stopped = False

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
        # 如果事件没有session_id，接收所有
        if not event.session_id:
            return True

        # 只接收当前会话的事件
        return event.session_id == self.session_id

    def _handle_event(self, event: Event):
        """
        事件处理器（同步版本）

        Args:
            event: 事件对象
        """
        try:
            # 放入异步队列（尝试，如果满了就跳过）
            try:
                self._event_queue.put_nowait(event)
            except:
                pass  # 异步队列可能未在async上下文中使用

            # 放入同步队列（用于非async环境）
            try:
                self._sync_event_queue.put_nowait(event)
            except:
                logger.warning(f"[SSEAdapter] 同步事件队列已满，丢弃事件: {event.type.value}")

        except Exception as e:
            logger.error(f"[SSEAdapter] 处理事件失败: {e}")

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

                    # ✨ 特殊处理 final_answer：拆分为 chunks 流式输出
                    if event.type == EventType.FINAL_ANSWER and self.enable_final_answer_streaming:
                        content = event.data.get("content", "")

                        # 先发送 chunks（流式打字效果）
                        for i in range(0, len(content), self.chunk_size):
                            chunk = content[i:i + self.chunk_size]

                            # ✨ 创建完整的 Event 对象格式的 chunk
                            chunk_event = {
                                "type": EventType.CHUNK.value,
                                "event_id": event.event_id,  # 复用原事件ID
                                "timestamp": time.time(),
                                "priority": event.priority.value,
                                "session_id": event.session_id,
                                "trace_id": event.trace_id,
                                "span_id": event.span_id,
                                "agent_name": event.agent_name,
                                "data": {
                                    "content": chunk
                                },
                                "requires_user_action": False,
                                "user_action_timeout": None
                            }
                            chunk_sse = f"data: {json.dumps(chunk_event, ensure_ascii=False)}\n\n"
                            yield chunk_sse

                        # 最后发送完整的 final_answer（包含元数据）
                        sse_data = self._format_sse(event)
                        yield sse_data
                    else:
                        # 其他事件正常输出
                        sse_data = self._format_sse(event)
                        yield sse_data

                    last_heartbeat = time.time()

                    # ✨ 检测结束事件，自动停止流
                    if event.type in [EventType.SESSION_END, EventType.AGENT_END]:
                        logger.info(f"[SSEAdapter] 检测到结束事件 ({event.type.value})，停止流式输出")
                        break

                except asyncio.TimeoutError:
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

                    # ✨ 特殊处理 final_answer：拆分为 chunks 流式输出
                    if event.type == EventType.FINAL_ANSWER and self.enable_final_answer_streaming:
                        content = event.data.get("content", "")

                        # 先发送 chunks（流式打字效果）
                        for i in range(0, len(content), self.chunk_size):
                            chunk = content[i:i + self.chunk_size]

                            # ✨ 创建完整的 Event 对象格式的 chunk
                            chunk_event = {
                                "type": EventType.CHUNK.value,
                                "event_id": event.event_id,  # 复用原事件ID
                                "timestamp": time.time(),
                                "priority": event.priority.value,
                                "session_id": event.session_id,
                                "trace_id": event.trace_id,
                                "span_id": event.span_id,
                                "agent_name": event.agent_name,
                                "data": {
                                    "content": chunk
                                },
                                "requires_user_action": False,
                                "user_action_timeout": None
                            }
                            chunk_sse = f"data: {json.dumps(chunk_event, ensure_ascii=False)}\n\n"
                            yield chunk_sse

                        # 最后发送完整的 final_answer（包含元数据）
                        sse_data = self._format_sse(event)
                        yield sse_data
                    else:
                        # 其他事件正常输出
                        sse_data = self._format_sse(event)
                        yield sse_data

                    last_heartbeat = time.time()

                    # 标记任务完成
                    self._sync_event_queue.task_done()

                    # ✨ 检测结束事件，自动停止流
                    if event.type in [EventType.SESSION_END, EventType.AGENT_END]:
                        logger.info(f"[SSEAdapter] 检测到结束事件 ({event.type.value})，停止流式输出")
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
        """
        将事件格式化为SSE格式（完整的Event对象格式）

        Args:
            event: 事件对象

        Returns:
            str: SSE格式的数据
        """
        # ✨ 使用完整的Event对象格式
        full_event = self._to_full_event_dict(event)

        # 序列化为JSON
        json_data = json.dumps(full_event, ensure_ascii=False)

        # SSE格式: "data: {json}\\n\\n"
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
                "agent_name": "master_agent_v2",
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

            # 事件数据（完整保留）
            "data": event.data or {},

            # 用户交互
            "requires_user_action": event.requires_user_action,
            "user_action_timeout": event.user_action_timeout
        }

    def _heartbeat(self) -> str:
        """
        生成心跳SSE

        Returns:
            str: 心跳SSE数据
        """
        heartbeat_data = {
            "type": "heartbeat",
            "timestamp": time.time()
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
