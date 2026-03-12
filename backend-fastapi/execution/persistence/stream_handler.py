# -*- coding: utf-8 -*-
"""
流式执行持久化处理器。

封装 Agent 流式执行过程中的数据库持久化逻辑。
"""

import logging
from threading import Event as ThreadingEvent
from typing import List, Optional, Dict, Any

from agents.events.bus import EventType, Event
from execution.observability import attach_execution_metadata

logger = logging.getLogger(__name__)


class StreamPersistenceHandler:
    """
    流式执行持久化处理器。

    负责订阅事件总线并将关键事件持久化到数据库。
    """

    def __init__(
        self,
        event_bus,
        store,
        session_id: str,
        run_id: str,
        cancel_event: ThreadingEvent,
        entry_agent_name: str = 'orchestrator_agent',
    ):
        self.event_bus = event_bus
        self.store = store
        self.session_id = session_id
        self.run_id = run_id
        self.cancel_event = cancel_event
        self.entry_agent_name = entry_agent_name

        # 状态标志
        self.final_answer_saved = ThreadingEvent()
        self.message_id_for_run: List[Optional[int]] = [None]

        # 订阅 ID
        self.subscription_ids: Dict[str, str] = {}

    def subscribe_all(self) -> Dict[str, str]:
        """
        订阅所有持久化事件。

        返回: 订阅 ID 字典
        """
        self.subscription_ids = {
            'interrupt': self._subscribe_user_interrupt(),
            'compression': self._subscribe_compression_summary(),
            'react_intermediate': self._subscribe_react_intermediate(),
            'persist_final_answer': self._subscribe_final_answer(),
            'run_steps': self._subscribe_run_steps(),
        }
        return self.subscription_ids

    def unsubscribe_all(self):
        """取消所有订阅。"""
        for subscription_id in self.subscription_ids.values():
            try:
                self.event_bus.unsubscribe(subscription_id)
            except Exception:
                pass
        self.subscription_ids.clear()

    def _subscribe_user_interrupt(self) -> str:
        """订阅用户中断事件。"""
        def handle_user_interrupt(event):
            logger.info('收到用户中断事件: session_id=%s', self.session_id)
            self.cancel_event.set()

        return self.event_bus.subscribe(
            event_types=[EventType.USER_INTERRUPT],
            handler=handle_user_interrupt,
            filter_func=lambda event: event.session_id == self.session_id,
        )

    def _subscribe_compression_summary(self) -> str:
        """订阅上下文压缩摘要事件。"""
        def handle_compression_summary(event):
            try:
                data = event.data or {}
                content = data.get('content')
                event_session_id = data.get('session_id') or event.session_id
                replaces_up_to_seq = data.get('replaces_up_to_seq')
                if content and event_session_id:
                    self.store.insert_compression_message(
                        session_id=event_session_id,
                        summary_content=content,
                        replaces_up_to_seq=replaces_up_to_seq,
                    )
                    logger.info(
                        '已保存压缩摘要到 DB: session_id=%s, replaces_up_to_seq=%s',
                        event_session_id, replaces_up_to_seq
                    )
            except Exception as error:
                logger.warning('保存压缩摘要失败: %s', error, exc_info=True)

        return self.event_bus.subscribe(
            event_types=[EventType.COMPRESSION_SUMMARY],
            handler=handle_compression_summary,
            filter_func=lambda event: event.session_id == self.session_id,
        )

    def _subscribe_react_intermediate(self) -> str:
        """订阅 ReAct 中间消息事件。"""
        def handle_react_intermediate(event):
            try:
                data = event.data or {}
                self.store.add_message(
                    session_id=self.session_id,
                    role=data.get('role', 'assistant'),
                    content=data.get('content', ''),
                    metadata={
                        'react_intermediate': True,
                        'msg_type': data.get('msg_type'),
                        'round': data.get('round'),
                        'run_id': self.run_id,
                        'agent': self.entry_agent_name,
                    },
                )
            except Exception as error:
                logger.warning('写入 react_intermediate 消息失败: %s', error, exc_info=True)

        return self.event_bus.subscribe(
            event_types=[EventType.REACT_INTERMEDIATE],
            handler=handle_react_intermediate,
            filter_func=lambda event: event.session_id == self.session_id,
        )

    def _subscribe_final_answer(self) -> str:
        """订阅最终答案事件。"""
        def handle_final_answer_persist(event):
            # 只处理默认入口智能体的最终答案
            if event.agent_name and event.agent_name != self.entry_agent_name:
                return
            if self.final_answer_saved.is_set():
                return
            content = (event.data or {}).get('content')
            if content is None:
                return
            try:
                message = self.store.add_message(
                    session_id=self.session_id,
                    role='assistant',
                    content=content if isinstance(content, str) else str(content),
                    metadata={'agent': event.agent_name, 'run_id': self.run_id},
                )
                self.message_id_for_run[0] = message['id']
                self.store.update_run_steps_message_id(self.session_id, self.run_id, message['id'])
                self.final_answer_saved.set()
                self.event_bus.publish(Event(
                    type=EventType.MESSAGE_SAVED,
                    data=attach_execution_metadata(
                        {'id': message['id'], 'seq': message.get('seq'), 'role': 'assistant'},
                        task_id=(event.data or {}).get('task_id'),
                        session_id=self.session_id,
                        run_id=self.run_id,
                        execution_kind='agent_stream',
                        request_id=(event.data or {}).get('request_id'),
                    ),
                    session_id=self.session_id,
                    agent_name=event.agent_name,
                ))
            except Exception as error:
                logger.warning('写入 assistant 消息失败: %s', error, exc_info=True)

        return self.event_bus.subscribe(
            event_types=[EventType.FINAL_ANSWER],
            handler=handle_final_answer_persist,
            filter_func=lambda event: event.session_id == self.session_id,
            priority=10,
        )

    def _subscribe_run_steps(self) -> str:
        """订阅运行步骤事件。"""
        step_event_types = [
            EventType.RUN_START,
            EventType.AGENT_START,
            EventType.THINKING_COMPLETE,
            EventType.REACT_INTERMEDIATE,
            EventType.CALL_AGENT_START,
            EventType.CALL_AGENT_END,
            EventType.CALL_TOOL_START,
            EventType.CALL_TOOL_END,
            EventType.CHART_GENERATED,
            EventType.MAP_GENERATED,
            EventType.RUN_END,
        ]

        def handle_step_and_final_answer(event):
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
            event_types=step_event_types,
            handler=handle_step_and_final_answer,
            filter_func=lambda event: event.session_id == self.session_id,
        )

    @staticmethod
    def _make_payload_safe(data: Any) -> Dict[str, Any]:
        """确保 payload 可以 JSON 序列化。"""
        import json

        if data is None:
            return {}
        if not isinstance(data, dict):
            return {'value': str(data)}

        safe_data: Dict[str, Any] = {}
        for key, value in data.items():
            try:
                json.dumps(value, ensure_ascii=False)
                safe_data[key] = value
            except (TypeError, ValueError):
                safe_data[key] = str(value)
        return safe_data

    @classmethod
    def _event_to_payload(cls, event) -> Dict[str, Any]:
        """将事件转换为持久化 payload。"""
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
