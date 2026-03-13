# -*- coding: utf-8 -*-
"""
运行步骤持久化处理器。

负责将 run_steps 表相关事件持久化到数据库。
"""

import logging
from typing import Any, Dict, List, Optional

from agents.events.bus import EventType

logger = logging.getLogger(__name__)

_STEP_EVENT_TYPES = [
    EventType.RUN_START,
    EventType.AGENT_START,
    EventType.AGENT_END,
    # THINKING_COMPLETE 已携带完整思考内容，是历史回放的唯一来源。
    # REACT_INTERMEDIATE 不再持久化：它是流结束后的补发事件（历史兼容用途），
    # 内容与 THINKING_COMPLETE 完全重复，若同时存入 run_steps 会导致同一轮次
    # 出现两条 subtask_thought 记录，前端回放时产生重复思考块。
    EventType.THINKING_COMPLETE,
    EventType.CALL_AGENT_START,
    EventType.CALL_AGENT_END,
    EventType.CALL_TOOL_START,
    EventType.CALL_TOOL_END,
    EventType.CHART_GENERATED,
    EventType.MAP_GENERATED,
    EventType.RUN_END,
]


class RunStepPersistenceHandler:
    """
    运行步骤持久化处理器。

    订阅事件总线，将执行步骤事件写入 run_steps 表。
    """

    def __init__(
        self,
        event_bus,
        store,
        session_id: str,
        run_id: str,
        message_id_for_run: List[Optional[str]],
    ):
        self.event_bus = event_bus
        self.store = store
        self.session_id = session_id
        self.run_id = run_id
        # 与 MessagePersistenceHandler 共享的引用，RUN_END 时用于关联 message_id
        self.message_id_for_run = message_id_for_run

        self._subscription_id: Optional[str] = None

    def subscribe_all(self) -> dict:
        self._subscription_id = self._subscribe_run_steps()
        return {'run_steps': self._subscription_id}

    def unsubscribe_all(self):
        if self._subscription_id:
            try:
                self.event_bus.unsubscribe(self._subscription_id)
            except Exception:
                pass
            self._subscription_id = None

    def _subscribe_run_steps(self) -> str:
        def handle(event):
            payload = self._event_to_payload(event)
            try:
                self.store.add_run_step(
                    session_id=self.session_id,
                    run_id=self.run_id,
                    step_type=event.type.value,
                    payload=payload,
                    message_id=None,
                )
            except Exception as error:
                logger.warning('写入 run_step 失败: %s', error, exc_info=True)

            if event.type == EventType.RUN_END and self.message_id_for_run[0]:
                try:
                    self.store.update_run_steps_message_id(
                        self.session_id, self.run_id, self.message_id_for_run[0]
                    )
                except Exception as error:
                    logger.warning('RUN_END 时更新 run_steps message_id 失败: %s', error, exc_info=True)

        return self.event_bus.subscribe(
            event_types=_STEP_EVENT_TYPES,
            handler=handle,
            filter_func=lambda e: e.session_id == self.session_id,
        )

    @staticmethod
    def _make_payload_safe(data: Any) -> Dict[str, Any]:
        import json
        if data is None:
            return {}
        if not isinstance(data, dict):
            return {'value': str(data)}
        safe: Dict[str, Any] = {}
        for key, value in data.items():
            if isinstance(value, (str, int, float, bool, type(None))):
                safe[key] = value
            else:
                try:
                    json.dumps(value, ensure_ascii=False)
                    safe[key] = value
                except (TypeError, ValueError):
                    safe[key] = str(value)
        return safe

    @classmethod
    def _event_to_payload(cls, event) -> Dict[str, Any]:
        from execution.observability import apply_observability_fields
        payload = {
            'type': event.type.value,
            'event_id': getattr(event, 'event_id', None),
            'timestamp': getattr(event, 'timestamp', None),
            'priority': getattr(getattr(event, 'priority', None), 'value', None),
            'session_id': getattr(event, 'session_id', None),
            'trace_id': getattr(event, 'trace_id', None),
            'span_id': getattr(event, 'span_id', None),
            'agent_name': event.agent_name,
            'call_id': getattr(event, 'call_id', None),
            'parent_call_id': getattr(event, 'parent_call_id', None),
            'data': cls._make_payload_safe(event.data),
            'requires_user_action': getattr(event, 'requires_user_action', False),
            'user_action_timeout': getattr(event, 'user_action_timeout', None),
        }
        apply_observability_fields(payload, event.data or {})
        if event.type in (EventType.CALL_AGENT_START, EventType.CALL_AGENT_END):
            called = (event.data or {}).get('agent_name')
            if called is not None:
                payload['agent_name'] = called
        return payload
