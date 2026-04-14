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
import re
from threading import Event as ThreadingEvent, Lock
from typing import List, Optional

from agents.events.bus import EventType, Event
from execution.observability import attach_execution_metadata
from services.memory_store import MemoryStore

logger = logging.getLogger(__name__)

_ALLOWED_INTERMEDIATE_TYPES = frozenset({'intent', 'observation'})
_MEMORY_PREFERENCE_PATTERNS = [
    (re.compile(r'优先最少代码'), '用户偏好-最少代码', '当前 session 中用户明确要求方案优先最少代码', 'preference', '后续方案优先最少代码。'),
    (re.compile(r'不要兼容层|不考虑兼容性'), '用户偏好-不要兼容层', '当前 session 中用户明确要求不要保留兼容层', 'constraint', '后续实现不要保留兼容层。'),
    (re.compile(r'请用中文|回答请使用中文'), '用户偏好-使用中文', '当前 session 中用户明确要求后续回答使用中文', 'preference', '后续回答默认使用中文。'),
]

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
        thread_key: str = 'root',
        conversation_scope: str = 'root',
        visible_to_user: bool = True,
        child_agent_id: Optional[str] = None,
    ):
        self.event_bus = event_bus
        self.store = store
        self.session_id = session_id
        self.run_id = run_id
        self.cancel_event = cancel_event
        self.entry_agent_name = entry_agent_name
        self.thread_key = thread_key
        self.conversation_scope = conversation_scope
        self.visible_to_user = visible_to_user
        self.child_agent_id = child_agent_id

        self.final_answer_saved = ThreadingEvent()
        self._final_answer_lock = Lock()
        self.message_id_for_run: List[Optional[str]] = [None]
        # 当前持久化边界对应的入口调用节点 ID（root 与 child 统一语义）
        self.entry_call_id: Optional[str] = None

        self._subscription_id: Optional[str] = None
        self._memory_store = MemoryStore()

    # ── 事件类型常量 ──
    _EVENT_TYPES = [
        EventType.USER_INTERRUPT,
        EventType.COMPRESSION_SUMMARY,
        EventType.AGENT_START,
        EventType.CALL_AGENT_START,
        EventType.REACT_INTERMEDIATE,
        EventType.FINAL_ANSWER,
    ]

    def subscribe_all(self) -> dict:
        self._subscription_id = self.event_bus.subscribe(
            event_types=self._EVENT_TYPES,
            handler=self._dispatch,
            filter_func=lambda e: e.session_id == self.session_id,
            priority=10,
        )
        return {'persistence': self._subscription_id}

    def unsubscribe_all(self):
        if self._subscription_id:
            try:
                self.event_bus.unsubscribe(self._subscription_id)
            except Exception:
                pass
            self._subscription_id = None

    def _dispatch(self, event: Event):
        """按 event.type 分发到对应 handler。"""
        etype = event.type
        if etype == EventType.USER_INTERRUPT:
            self._handle_user_interrupt(event)
        elif etype == EventType.COMPRESSION_SUMMARY:
            self._handle_compression_summary(event)
        elif etype in (EventType.AGENT_START, EventType.CALL_AGENT_START):
            self._handle_entry_call_id(event)
        elif etype == EventType.REACT_INTERMEDIATE:
            self._handle_react_intermediate(event)
        elif etype == EventType.FINAL_ANSWER:
            self._handle_final_answer(event)

    def _handle_user_interrupt(self, event):
        logger.info('收到用户中断事件: session_id=%s', self.session_id)
        self.cancel_event.set()
        with self._final_answer_lock:
            if self.final_answer_saved.is_set():
                return
            try:
                message = self.store.add_message(
                    session_id=self.session_id,
                    role='assistant',
                    content='[interrupted]',
                    metadata={
                        'agent': self.entry_agent_name,
                        'run_id': self.run_id,
                        'thread_key': self.thread_key,
                        'conversation_scope': self.conversation_scope,
                        'visible_to_user': self.visible_to_user,
                        'child_agent_id': self.child_agent_id,
                        'interrupted': True,
                    },
                    thread_key=self.thread_key,
                    child_agent_id=self.child_agent_id,
                )
                self.message_id_for_run[0] = message['id']
                self.store.update_run_steps_message_id(self.session_id, self.run_id, message['id'])
                self.final_answer_saved.set()
                self.store.add_message(
                    session_id=self.session_id,
                    role='user',
                    content='[Request interrupted by user]',
                    metadata={
                        'hidden': True,
                        'interrupted': True,
                        'thread_key': self.thread_key,
                        'conversation_scope': self.conversation_scope,
                        'child_agent_id': self.child_agent_id,
                    },
                    thread_key=self.thread_key,
                    child_agent_id=self.child_agent_id,
                )
                logger.info('已保存中断消息: session_id=%s msg_id=%s', self.session_id, message['id'])
            except Exception as error:
                logger.warning('保存中断消息失败: %s', error, exc_info=True)

    def _handle_compression_summary(self, event):
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

    def _handle_entry_call_id(self, event):
        if self.entry_call_id is None and getattr(event, 'parent_call_id', None) is None:
            self.entry_call_id = getattr(event, 'call_id', None)
            logger.debug('捕获 entry_call_id=%s', self.entry_call_id)

    def _handle_react_intermediate(self, event):
        if self.entry_call_id is not None:
            if getattr(event, 'call_id', None) != self.entry_call_id:
                return
        elif event.agent_name and event.agent_name != self.entry_agent_name:
            return
        try:
            data = event.data or {}
            raw_msg_type = data.get('msg_type')
            normalized_msg_type = raw_msg_type
            if normalized_msg_type not in _ALLOWED_INTERMEDIATE_TYPES:
                normalized_msg_type = 'observation'
            self.store.add_message(
                session_id=self.session_id,
                role=data.get('role', 'assistant'),
                content=data.get('content', ''),
                metadata={
                    'react_intermediate': True,
                    'msg_type': normalized_msg_type,
                    'round': data.get('round'),
                    'run_id': self.run_id,
                    'agent': event.agent_name or self.entry_agent_name,
                    'thread_key': self.thread_key,
                    'conversation_scope': self.conversation_scope,
                    'visible_to_user': self.visible_to_user,
                    'child_agent_id': self.child_agent_id,
                },
                thread_key=self.thread_key,
                child_agent_id=self.child_agent_id,
            )
        except Exception as error:
            logger.warning('写入 react_intermediate 消息失败: %s', error, exc_info=True)

    def _handle_final_answer(self, event):
        if self.entry_call_id is not None:
            if getattr(event, 'call_id', None) != self.entry_call_id:
                return
        elif event.agent_name and event.agent_name != self.entry_agent_name:
            return
        with self._final_answer_lock:
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
                    metadata={
                        'agent': event.agent_name,
                        'run_id': self.run_id,
                        'thread_key': self.thread_key,
                        'conversation_scope': self.conversation_scope,
                        'visible_to_user': self.visible_to_user,
                        'child_agent_id': self.child_agent_id,
                    },
                    thread_key=self.thread_key,
                    child_agent_id=self.child_agent_id,
                )
                self.message_id_for_run[0] = message['id']
                self.store.update_run_steps_message_id(self.session_id, self.run_id, message['id'])
                self._persist_session_memories(
                    content=content if isinstance(content, str) else str(content),
                    message_id=message['id'],
                    agent_name=event.agent_name or self.entry_agent_name,
                )
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

    def _persist_session_memories(self, *, content: str, message_id: str, agent_name: str) -> None:
        if self.conversation_scope != 'root':
            return
        latest_user_message = self.store.get_recent_messages(
            session_id=self.session_id,
            limit=20,
            thread_key=self.thread_key,
        )
        latest_user_text = ''
        for item in reversed(latest_user_message):
            if item.get('role') == 'user':
                latest_user_text = (item.get('content') or '').strip()
                break
        source_text = f"{latest_user_text}\n{content}".strip()
        if not source_text:
            return
        for pattern, name, description, memory_type, memory_content in _MEMORY_PREFERENCE_PATTERNS:
            if not pattern.search(source_text):
                continue
            try:
                self._memory_store.save_memory(
                    scope='session',
                    session_id=self.session_id,
                    agent_name=agent_name,
                    name=name,
                    description=description,
                    memory_type=memory_type,
                    content=memory_content,
                    why='来源于当前 session 中明确表达且后续可复用的稳定要求。',
                    how_to_apply='后续同一 session 的方案和回答默认遵循该要求。',
                    source_run_id=self.run_id,
                    source_message_id=message_id,
                )
            except Exception as error:
                logger.warning('写入 session memory 失败: %s', error, exc_info=True)

