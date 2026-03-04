# -*- coding: utf-8 -*-
"""
事件发布器 - 简化Agent发布事件的辅助类
"""

import logging
from typing import Optional, Dict, Any
from contextvars import ContextVar

from .bus import (
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
        call_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        event_bus: Optional[EventBus] = None
    ):
        """
        初始化事件发布器

        Args:
            agent_name: Agent名称
            session_id: 会话ID
            trace_id: 追踪ID
            span_id: 当前Span ID
            call_id: 当前调用节点ID（用于构建调用树）
            parent_call_id: 父调用节点ID（用于构建调用树）
            event_bus: 事件总线实例（None则使用全局）
        """
        self.agent_name = agent_name
        self.session_id = session_id
        self.trace_id = trace_id
        self.span_id = span_id
        self.call_id = call_id
        self.parent_call_id = parent_call_id
        self.event_bus = event_bus or get_current_event_bus()

    def _publish(
        self,
        event_type: EventType,
        data: Dict[str, Any],
        priority: EventPriority = EventPriority.NORMAL,
        requires_user_action: bool = False,
        user_action_timeout: Optional[float] = None,
        override_call_id: Optional[str] = None,        # ✨ 允许覆盖 call_id
        override_parent_call_id: Optional[str] = None  # ✨ 允许覆盖 parent_call_id
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
            call_id=override_call_id if override_call_id is not None else self.call_id,
            parent_call_id=override_parent_call_id if override_parent_call_id is not None else self.parent_call_id,
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
        """简单思考（纯文本）- 兼容旧 API"""
        self._publish(
            EventType.THINKING,
            {"content": content}
        )

    def thinking(self, content: str):
        """简单思考（纯文本）"""
        self._publish(
            EventType.THINKING,
            {"content": content}
        )

    def thought_structured(
        self,
        thought: str = "",
        actions: Optional[list] = None,
        reasoning: Optional[str] = None,
        round: Optional[int] = None,
        thinking: Optional[str] = None,
    ):
        """结构化思考（ReAct风格）- 兼容旧 API，支持 thinking 参数"""
        # 优先使用 thinking 参数，向后兼容 thought
        content = thinking if thinking is not None else thought
        data: Dict[str, Any] = {
            "thinking": content,
            "thought": content,  # 兼容旧前端
            "actions": actions or [],
            "reasoning": reasoning,
        }
        if round is not None:
            data["round"] = round

        self._publish(
            EventType.THINKING_STRUCTURED,
            data,
        )

    def thinking_structured(
        self,
        thinking: str = "",
        actions: Optional[list] = None,
        reasoning: Optional[str] = None,
        round: Optional[int] = None,
    ):
        """结构化思考（ReAct风格）- 新 API"""
        data: Dict[str, Any] = {
            "thinking": thinking,
            "thought": thinking,  # 兼容旧前端
            "actions": actions or [],
            "reasoning": reasoning,
        }
        if round is not None:
            data["round"] = round

        self._publish(
            EventType.THINKING_STRUCTURED,
            data,
        )

    def thinking_delta(self, content: str, round: Optional[int] = None):
        """流式思考增量内容"""
        data: Dict[str, Any] = {"content": content}
        if round is not None:
            data["round"] = round
        self._publish(EventType.THINKING_DELTA, data)

    def thinking_complete(self, full_content: str, round: Optional[int] = None):
        """思考完成"""
        data: Dict[str, Any] = {"content": full_content}
        if round is not None:
            data["round"] = round
        self._publish(EventType.THINKING_COMPLETE, data)

    # ==================== 运行生命周期事件 ====================

    def run_start(self, run_id: str, metadata: Optional[Dict] = None):
        """运行开始"""
        self._publish(
            EventType.RUN_START,
            {
                "run_id": run_id,
                "metadata": metadata or {}
            }
        )

    def run_end(self, run_id: str, status: str = "success", summary: Optional[str] = None):
        """运行结束"""
        self._publish(
            EventType.RUN_END,
            {
                "run_id": run_id,
                "status": status,
                "summary": summary
            }
        )

    # ==================== Agent调用事件 ====================

    def agent_call_start(
        self,
        call_id: str,
        agent_name: str,
        description: str,
        parent_call_id: Optional[str] = None,
        order: Optional[int] = None,
        round: Optional[int] = None,
        round_index: Optional[int] = None
    ):
        """Agent调用开始"""
        data = {
            "agent_name": agent_name,
            "description": description,
        }
        if order is not None:
            data["order"] = order
        if round is not None:
            data["round"] = round
        if round_index is not None:
            data["round_index"] = round_index

        self._publish(
            EventType.CALL_AGENT_START,
            data,
            override_call_id=call_id,
            override_parent_call_id=parent_call_id
        )

    def agent_call_end(
        self,
        call_id: str,
        agent_name: str,
        result: str,
        success: bool = True,
        parent_call_id: Optional[str] = None,
        order: Optional[int] = None
    ):
        """Agent调用结束"""
        data = {
            "agent_name": agent_name,
            "result": str(result)[:500],
            "success": success
        }
        if order is not None:
            data["order"] = order

        self._publish(
            EventType.CALL_AGENT_END,
            data,
            override_call_id=call_id,
            override_parent_call_id=parent_call_id
        )

    # ==================== 工具调用事件（新版） ====================

    def tool_call_start(
        self,
        call_id: str,
        tool_name: str,
        arguments: Dict,
        parent_call_id: Optional[str] = None
    ):
        """工具调用开始"""
        self._publish(
            EventType.CALL_TOOL_START,
            {
                "tool_name": tool_name,
                "arguments": arguments
            },
            override_call_id=call_id,
            override_parent_call_id=parent_call_id
        )

    def tool_call_end(
        self,
        call_id: str,
        tool_name: str,
        result: Any,
        execution_time: Optional[float] = None,
        parent_call_id: Optional[str] = None
    ):
        """工具调用结束"""
        self._publish(
            EventType.CALL_TOOL_END,
            {
                "tool_name": tool_name,
                "result": str(result)[:500],
                "execution_time": execution_time
            },
            override_call_id=call_id,
            override_parent_call_id=parent_call_id
        )

    # ==================== 兼容旧 API（重定向到新事件或保留别名） ====================
    # 注意：旧 subtask_* 和 tool_* 方法可保留以兼容未迁移的代码，
    # 但建议在内部重定向到新事件，或逐步废弃。此处暂保留 tool_* 兼容性。

    def tool_start(
        self,
        tool_name: str,
        arguments: Dict,
        task_id: Optional[str] = None
    ):
        """[兼容] 工具开始执行"""
        # 尽量映射到新事件，若无 call_id 则生成临时的
        import uuid
        call_id = str(uuid.uuid4())
        self.tool_call_start(
            call_id=call_id,
            tool_name=tool_name,
            arguments=arguments,
            parent_call_id=task_id  # 旧 task_id 对应 parent_call_id
        )

    def tool_end(
        self,
        tool_name: str,
        result: Any,
        execution_time: Optional[float] = None,
        task_id: Optional[str] = None
    ):
        """[兼容] 工具执行完成"""
        # 由于无法获知 start 时的 call_id，此处仅做简单转发，或忽略 call_id
        # 更好的做法是修改调用方。此处为保持接口签名不变：
        self._publish(
            EventType.TOOL_END,
            {
                "tool_name": tool_name,
                "result": str(result)[:500],
                "execution_time": execution_time,
                "task_id": task_id
            }
        )

    # subtask_* 已废弃，建议直接移除或报错


    # ==================== ReAct 中间过程事件 ====================

    def react_intermediate(self, role: str, content: str, round: int, msg_type: str):
        """ReAct 中间消息（thought / observation）"""
        self._publish(
            EventType.REACT_INTERMEDIATE,
            {"role": role, "content": content, "round": round, "msg_type": msg_type}
        )

    # ==================== 流式输出事件 ====================

    def chunk(self, content: str):
        """流式输出片段"""
        self._publish(
            EventType.CHUNK,
            {"content": content}
        )

    def final_answer(self, content: str, metadata: dict = None):
        """最终答案完成信号（content 供后端写库用，前端通过 chunk 事件已获得完整内容）"""
        data = {"content": content}
        if metadata:
            data["metadata"] = metadata
        self._publish(
            EventType.FINAL_ANSWER,
            data,
            priority=EventPriority.HIGH
        )

    # ==================== 可视化事件 ====================

    def chart_generated(self, chart_config: Dict, chart_type: str, title: str = None):
        """图表生成"""
        # 从 echarts_config 中提取标题（如果没有提供）
        if not title and chart_config:
            title = chart_config.get('title', {}).get('text', 'Data Visualization')
        self._publish(
            EventType.CHART_GENERATED,
            {
                "chart_type": chart_type,
                "config": chart_config,
                "echarts_config": chart_config,
                "title": title or 'Data Visualization'
            }
        )

    def map_generated(self, map_data: Dict, map_type: str, title: str = None):
        """地图生成"""
        # 从 map_data 中提取标题（如果没有提供）
        if not title and map_data:
            title = map_data.get('title', 'Map Visualization')
        self._publish(
            EventType.MAP_GENERATED,
            {
                "map_type": map_type,
                "data": map_data,
                "mapData": map_data,
                "title": title or 'Map Visualization'
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

    # ==================== 上下文压缩事件 ====================

    def compression_summary(self, content: str, replaces_up_to_seq: int | None = None):
        """上下文压缩摘要"""
        self._publish(
            EventType.COMPRESSION_SUMMARY,
            {
                "content": content,
                "session_id": self.session_id,
                "replaces_up_to_seq": replaces_up_to_seq,
            }
        )

    # ==================== 代码执行事件（PTC） ====================

    def code_execution_start(self, description: str, code_preview: str):
        """代码执行开始"""
        self._publish(
            EventType.CODE_EXECUTION_START,
            {
                "description": description,
                "code_preview": code_preview[:200]
            }
        )

    def code_execution_end(self, result: Any, execution_time: float, tool_calls_count: int):
        """代码执行结束"""
        self._publish(
            EventType.CODE_EXECUTION_END,
            {
                "result_preview": str(result)[:500],
                "execution_time": execution_time,
                "tool_calls_count": tool_calls_count
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
        call_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        event_bus: Optional[EventBus] = None
    ):
        self.publisher = EventPublisher(
            agent_name=agent_name,
            session_id=session_id,
            trace_id=trace_id,
            span_id=span_id,
            call_id=call_id,
            parent_call_id=parent_call_id,
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
