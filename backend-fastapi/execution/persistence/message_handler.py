# -*- coding: utf-8 -*-
"""
消息持久化处理器。

负责将 messages 表相关事件持久化到数据库：
- 用户中断（cancel_event）
- 上下文压缩摘要
- ReAct 中间消息
- 最终答案
"""

import logging
from threading import Event as ThreadingEvent
from typing import List, Optional

from agents.events.bus import EventType, Event
from execution.observability import attach_execution_metadata

logger = logging.getLogger(__name__)


class MessagePersistenceHandler:
    """
    消息持久化处理器。

    订阅事件总线，将消息相关事件写入 messages 表。
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

        self.final_answer_saved = ThreadingEvent()
        self.message_id_for_run: List[Optional[str]] = [None]
        # 入口 Agent 的 root_call_id，首个 AGENT_START 事件时捕获
        self.root_call_id: Optional[str] = None

        self._subscription_ids: dict = {}

    def subscribe_all(self) -> dict:
        self._subscription_ids = {
            'interrupt': self._subscribe_user_interrupt(),
            'compression': self._subscribe_compression_summary(),
            'root_call_id': self._subscribe_root_call_id(),
            'react_intermediate': self._subscribe_react_intermediate(),
            'final_answer': self._subscribe_final_answer(),
        }
        return self._subscription_ids

    def unsubscribe_all(self):
        for sub_id in self._subscription_ids.values():
            try:
                self.event_bus.unsubscribe(sub_id)
            except Exception:
                pass
        self._subscription_ids.clear()

    def _subscribe_user_interrupt(self) -> str:
        def handle(event):
            logger.info('收到用户中断事件: session_id=%s', self.session_id)
            self.cancel_event.set()

        return self.event_bus.subscribe(
            event_types=[EventType.USER_INTERRUPT],
            handler=handle,
            filter_func=lambda e: e.session_id == self.session_id,
        )

    def _subscribe_compression_summary(self) -> str:
        def handle(event):
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
                        event_session_id, replaces_up_to_seq,
                    )
            except Exception as error:
                logger.warning('保存压缩摘要失败: %s', error, exc_info=True)

        return self.event_bus.subscribe(
            event_types=[EventType.COMPRESSION_SUMMARY],
            handler=handle,
            filter_func=lambda e: e.session_id == self.session_id,
        )

    def _subscribe_root_call_id(self) -> str:
        def handle(event):
            # parent_call_id 为 None 说明是顶层入口 Agent
            if self.root_call_id is None and getattr(event, 'parent_call_id', None) is None:
                self.root_call_id = getattr(event, 'call_id', None)
                logger.debug('捕获 root_call_id=%s', self.root_call_id)

        return self.event_bus.subscribe(
            event_types=[EventType.AGENT_START],
            handler=handle,
            filter_func=lambda e: e.session_id == self.session_id,
        )

    def _subscribe_react_intermediate(self) -> str:
        def handle(event):
            # 用 call_id 精确匹配入口 Agent，支持主智能体嵌套场景
            # root_call_id 已知时用它做精确匹配，否则降级到 agent_name 过滤
            if self.root_call_id is not None:
                if getattr(event, 'call_id', None) != self.root_call_id:
                    return
            elif event.agent_name and event.agent_name != self.entry_agent_name:
                return
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
            handler=handle,
            filter_func=lambda e: e.session_id == self.session_id,
        )

    def _subscribe_final_answer(self) -> str:
        def handle(event):
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
            handler=handle,
            filter_func=lambda e: e.session_id == self.session_id,
            priority=10,
        )
