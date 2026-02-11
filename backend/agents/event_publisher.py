# -*- coding: utf-8 -*-
"""
事件发布器 - 简化Agent发布事件的辅助类
"""

import logging
from typing import Optional, Dict, Any
from contextvars import ContextVar

from .event_bus import (
    EventBus, Event, EventType, EventPriority,
    get_current_event_bus
)

logger = logging.getLogger(__name__)


class EventPublisher:
    """
    事件发布器 - 为Agent提供简洁的事件发布API

    使用方式:
        publisher = EventPublisher(agent_name="kgqa_agent", session_id="abc123")
        publisher.thought("我需要查询知识图谱")
        publisher.tool_start("query_knowledge_graph", {...})
    """

    def __init__(
        self,
        agent_name: str,
        session_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        span_id: Optional[str] = None,
        event_bus: Optional[EventBus] = None
    ):
        """
        初始化事件发布器

        Args:
            agent_name: Agent名称
            session_id: 会话ID
            trace_id: 追踪ID
            span_id: 当前Span ID
            event_bus: 事件总线实例（None则使用全局）
        """
        self.agent_name = agent_name
        self.session_id = session_id
        self.trace_id = trace_id
        self.span_id = span_id
        self.event_bus = event_bus or get_current_event_bus()

    def _publish(
        self,
        event_type: EventType,
        data: Dict[str, Any],
        priority: EventPriority = EventPriority.NORMAL,
        requires_user_action: bool = False,
        user_action_timeout: Optional[float] = None
    ):
        """内部发布方法"""
        event = Event(
            type=event_type,
            data=data,
            priority=priority,
            session_id=self.session_id,
            trace_id=self.trace_id,
            span_id=self.span_id,
            agent_name=self.agent_name,
            requires_user_action=requires_user_action,
            user_action_timeout=user_action_timeout
        )

        if self.event_bus:
            self.event_bus.publish(event)
        else:
            logger.warning(f"[{self.agent_name}] 事件总线未初始化，跳过事件: {event_type.value}")

    # ==================== Agent执行事件 ====================

    def agent_start(self, task: str, metadata: Optional[Dict] = None):
        """Agent开始执行"""
        self._publish(
            EventType.AGENT_START,
            {
                "agent_name": self.agent_name,
                "task": task,
                "metadata": metadata or {}
            }
        )

    def agent_end(self, result: Any, execution_time: Optional[float] = None):
        """Agent执行完成"""
        self._publish(
            EventType.AGENT_END,
            {
                "agent_name": self.agent_name,
                "result": str(result)[:500],  # 截断过长的结果
                "execution_time": execution_time
            }
        )

    def agent_error(self, error: str, error_type: Optional[str] = None):
        """Agent执行错误"""
        self._publish(
            EventType.AGENT_ERROR,
            {
                "agent_name": self.agent_name,
                "error": error,
                "error_type": error_type
            },
            priority=EventPriority.HIGH
        )

    # ==================== 思考过程事件 ====================

    def thought(self, content: str):
        """简单思考（纯文本）"""
        self._publish(
            EventType.THOUGHT,
            {"content": content}
        )

    def thought_structured(
        self,
        thought: str,
        actions: Optional[list] = None,
        reasoning: Optional[str] = None
    ):
        """结构化思考（ReAct风格）"""
        self._publish(
            EventType.THOUGHT_STRUCTURED,
            {
                "thought": thought,
                "actions": actions or [],
                "reasoning": reasoning
            }
        )

    # ==================== 工具调用事件 ====================

    def tool_start(
        self,
        tool_name: str,
        arguments: Dict,
        task_id: Optional[str] = None  # ✨ 新增：关联到哪个子任务
    ):
        """
        工具开始执行

        Args:
            tool_name: 工具名称
            arguments: 工具参数
            task_id: 所属子任务的ID（用于前端归类）
        """
        data = {
            "tool_name": tool_name,
            "arguments": arguments
        }

        # ✨ 关联到子任务
        if task_id:
            data["task_id"] = task_id

        self._publish(EventType.TOOL_START, data)

    def tool_end(
        self,
        tool_name: str,
        result: Any,
        execution_time: Optional[float] = None,
        task_id: Optional[str] = None  # ✨ 新增：关联到哪个子任务
    ):
        """
        工具执行完成

        Args:
            tool_name: 工具名称
            result: 执行结果
            execution_time: 执行时间
            task_id: 所属子任务的ID
        """
        data = {
            "tool_name": tool_name,
            "result": str(result)[:500],  # 截断过长的结果
            "execution_time": execution_time
        }

        # ✨ 关联到子任务
        if task_id:
            data["task_id"] = task_id

        self._publish(EventType.TOOL_END, data)

    def tool_error(self, tool_name: str, error: str):
        """工具执行错误"""
        self._publish(
            EventType.TOOL_ERROR,
            {
                "tool_name": tool_name,
                "error": error
            },
            priority=EventPriority.HIGH
        )

    # ==================== 子任务事件 ====================

    def subtask_start(
        self,
        subtask_agent: str,
        subtask_description: str,
        task_id: Optional[str] = None,      # ✨ 新增：任务唯一ID
        order: Optional[int] = None,        # ✨ 新增：调用顺序
        round: Optional[int] = None         # ✨ 新增：第几轮推理
    ):
        """
        子任务开始

        Args:
            subtask_agent: 子agent名称
            subtask_description: 子任务描述
            task_id: 任务唯一ID（用于前端关联事件）
            order: 调用顺序（全局递增）
            round: 第几轮推理
        """
        data = {
            "subtask_agent": subtask_agent,
            "subtask_description": subtask_description,
        }

        # ✨ 添加任务追踪信息
        if task_id:
            data["task_id"] = task_id
        if order is not None:
            data["order"] = order
        if round is not None:
            data["round"] = round

        self._publish(EventType.SUBTASK_START, data)

    def subtask_end(
        self,
        subtask_agent: str,
        subtask_result: str,
        success: bool = True,
        task_id: Optional[str] = None,      # ✨ 新增：任务唯一ID
        order: Optional[int] = None         # ✨ 新增：调用顺序
    ):
        """
        子任务完成

        Args:
            subtask_agent: 子agent名称
            subtask_result: 子任务结果摘要
            success: 是否成功
            task_id: 任务唯一ID
            order: 调用顺序
        """
        data = {
            "subtask_agent": subtask_agent,
            "subtask_result": subtask_result[:500],  # 截断过长结果
            "success": success
        }

        # ✨ 添加任务追踪信息
        if task_id:
            data["task_id"] = task_id
        if order is not None:
            data["order"] = order

        self._publish(EventType.SUBTASK_END, data)

    # ==================== 流式输出事件 ====================

    def chunk(self, content: str):
        """流式输出片段"""
        self._publish(
            EventType.CHUNK,
            {"content": content}
        )

    def final_answer(self, content: str):
        """最终答案"""
        self._publish(
            EventType.FINAL_ANSWER,
            {"content": content},
            priority=EventPriority.HIGH
        )

    # ==================== 可视化事件 ====================

    def chart_generated(self, chart_config: Dict, chart_type: str):
        """图表生成"""
        self._publish(
            EventType.CHART_GENERATED,
            {
                "chart_type": chart_type,
                "config": chart_config
            }
        )

    def map_generated(self, map_data: Dict, map_type: str):
        """地图生成"""
        self._publish(
            EventType.MAP_GENERATED,
            {
                "map_type": map_type,
                "data": map_data
            }
        )

    # ==================== 用户交互事件 ====================

    async def request_user_approval(
        self,
        action_description: str,
        timeout: float = 60.0
    ) -> bool:
        """
        请求用户许可（阻塞等待用户响应）

        Args:
            action_description: 动作描述
            timeout: 超时时间（秒）

        Returns:
            bool: True=用户同意, False=用户拒绝或超时
        """
        if not self.event_bus:
            logger.warning(f"[{self.agent_name}] 事件总线未初始化，自动批准")
            return True

        return await self.event_bus.request_user_approval(
            agent_name=self.agent_name,
            action_description=action_description,
            timeout=timeout,
            session_id=self.session_id,
            trace_id=self.trace_id
        )

    def user_feedback(self, feedback: str, feedback_type: str = "info"):
        """用户反馈"""
        self._publish(
            EventType.USER_FEEDBACK,
            {
                "feedback": feedback,
                "feedback_type": feedback_type
            }
        )

    # ==================== 会话事件 ====================

    def session_start(self, metadata: Optional[Dict] = None):
        """会话开始"""
        self._publish(
            EventType.SESSION_START,
            {
                "session_id": self.session_id,
                "metadata": metadata or {}
            }
        )

    def session_end(self, summary: Optional[str] = None):
        """会话结束"""
        self._publish(
            EventType.SESSION_END,
            {
                "session_id": self.session_id,
                "summary": summary
            }
        )


# ==================== 上下文管理器 ====================

class EventPublisherContext:
    """
    事件发布器上下文管理器

    使用方式:
        with EventPublisherContext("kgqa_agent", session_id="abc") as publisher:
            publisher.agent_start("查询知识图谱")
            ...
            publisher.agent_end("查询完成")
    """

    def __init__(
        self,
        agent_name: str,
        session_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        span_id: Optional[str] = None,
        event_bus: Optional[EventBus] = None
    ):
        self.publisher = EventPublisher(
            agent_name=agent_name,
            session_id=session_id,
            trace_id=trace_id,
            span_id=span_id,
            event_bus=event_bus
        )

    def __enter__(self) -> EventPublisher:
        return self.publisher

    def __exit__(self, exc_type, exc_val, exc_tb):
        # 如果有异常，自动发布错误事件
        if exc_type is not None:
            self.publisher.agent_error(
                error=str(exc_val),
                error_type=exc_type.__name__
            )
        return False
