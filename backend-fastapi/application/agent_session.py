# -*- coding: utf-8 -*-
"""Agent session use cases."""

from __future__ import annotations

from typing import Any, Dict, Optional

from execution.runstep_normalizer import normalize_run_steps
from services.conversation_store import ConversationStore
from runtime.dependencies import get_runtime_dependency


class AgentSessionApplication:
    """Own session and conversation persistence workflows."""

    def __init__(self, *, conversation_store: Optional[ConversationStore] = None):
        self._conversation_store = conversation_store or ConversationStore()

    def get_conversation_store(self) -> ConversationStore:
        return self._conversation_store

    def create_session(
        self,
        *,
        session_id: str,
        user_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        metadata = metadata or {}
        self._conversation_store.create_session(session_id=session_id, user_id=user_id, metadata=metadata)
        return {
            'session_id': session_id,
            'user_id': user_id,
            'metadata': metadata,
        }

    def list_sessions(self, *, limit: int = 20, offset: int = 0, user_id: Optional[str] = None) -> Dict[str, Any]:
        return self._conversation_store.list_sessions(limit=limit, offset=offset, user_id=user_id)

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        return self._conversation_store.get_session(session_id=session_id)

    def delete_session(self, session_id: str) -> bool:
        session = self.get_session(session_id)
        if not session:
            return False
        self._conversation_store.delete_session(session_id=session_id)
        return True

    def rollback_messages(
        self,
        *,
        session_id: str,
        after_seq: Optional[int] = None,
        after_message_id: Optional[str] = None,
    ) -> int:
        return self._conversation_store.delete_messages_after(
            session_id=session_id,
            after_seq=after_seq,
            after_message_id=after_message_id,
        )

    def prepare_retry(
        self,
        *,
        session_id: str,
        after_seq: int,
        modify_user_message: Optional[str] = None,
    ) -> Dict[str, Any]:
        original_message = self._conversation_store.get_message_by_seq(session_id=session_id, seq=after_seq)
        if not original_message:
            raise ValueError(f'未找到会话 {session_id} 中序号为 {after_seq} 的消息')
        if original_message.get('role') != 'user':
            raise ValueError('指定位置必须是用户消息（user），才能从此处重试')

        deleted = self.rollback_messages(session_id=session_id, after_seq=after_seq)
        task = (modify_user_message or '').strip() or (original_message.get('content') or '').strip()
        if not task:
            raise ValueError('无法获取要重试的任务内容')

        if modify_user_message is not None:
            self._conversation_store.update_message(
                message_id=original_message['id'],
                content=task,
                session_id=session_id,
                role_filter='user',
            )

        return {
            'deleted': deleted,
            'task': task,
            'message': original_message,
        }

    def update_user_message(self, *, session_id: str, message_id: str, content: str) -> bool:
        return self._conversation_store.update_message(
            message_id=message_id,
            content=content,
            session_id=session_id,
            role_filter='user',
        )

    def list_messages(
        self,
        *,
        session_id: str,
        limit: int = 20,
        offset: int = 0,
        expand_steps: bool = True,
    ) -> Dict[str, Any]:
        data = self._conversation_store.list_messages(session_id=session_id, limit=limit, offset=offset)
        if data.get('items'):
            data['items'] = [
                item for item in data['items']
                if not (item.get('metadata') or {}).get('react_intermediate')
            ]
        if expand_steps and data.get('items'):
            for item in data['items']:
                metadata = item.get('metadata') or {}
                run_id = metadata.get('run_id')
                if item.get('role') != 'assistant' or not run_id:
                    continue
                raw_steps = self._conversation_store.list_run_steps(
                    run_id=run_id,
                    session_id=session_id,
                    limit=500,
                )
                item['run_steps'] = normalize_run_steps(
                    raw_steps,
                    entry_agent_name=(metadata.get('agent') or 'orchestrator_agent'),
                )
        return data

    def add_assistant_message(self, *, session_id: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        self._conversation_store.add_message(
            session_id=session_id,
            role='assistant',
            content=content,
            metadata=metadata or {},
        )


def get_agent_session_application() -> AgentSessionApplication:
    return get_runtime_dependency(container_getter='get_agent_session_application')
