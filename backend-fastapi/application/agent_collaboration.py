# -*- coding: utf-8 -*-
"""Agent recovery and replay use cases."""

from __future__ import annotations

from typing import Optional

from agents.recovery import CheckpointManager
from runtime.dependencies import get_runtime_dependency

from .agent_chat import AgentChatApplication, get_agent_chat_application
from .agent_session import AgentSessionApplication, get_agent_session_application


class AgentCollaborationApplication:
    """Coordinate checkpoint recovery and replay flows."""

    def __init__(
        self,
        *,
        checkpoint_manager: Optional[CheckpointManager] = None,
        chat_application: Optional[AgentChatApplication] = None,
        session_application: Optional[AgentSessionApplication] = None,
    ):
        self._checkpoint_manager = checkpoint_manager or CheckpointManager()
        self._chat_application = chat_application or get_agent_chat_application()
        self._session_application = session_application or get_agent_session_application()

    def recover_session(self, session_id: str, payload: Optional[dict]) -> dict:
        body = payload or {}
        checkpoint_id = body.get('checkpoint_id')
        agent_name = body.get('agent_name')

        if checkpoint_id:
            checkpoint = self._checkpoint_manager.load_checkpoint(checkpoint_id)
        else:
            checkpoint = self._checkpoint_manager.get_latest_checkpoint(session_id=session_id, agent_name=agent_name)

        if not checkpoint:
            raise LookupError('未找到可用的检查点')

        context = self._chat_application.build_context(
            session_id=session_id,
            user_id=body.get('user_id'),
            limit=0,
        )
        for msg in checkpoint['messages']:
            context.add_message(
                role=msg['role'],
                content=msg['content'],
                metadata=msg.get('metadata', {}),
            )

        user_messages = [item for item in checkpoint['messages'] if item['role'] == 'user']
        if not user_messages:
            raise ValueError('检查点中没有用户消息')

        task = user_messages[-1]['content']
        response = self._chat_application.get_orchestrator().execute(
            task=task,
            context=context,
            agent_name=checkpoint['agent_name'],
        )

        if response.success and response.content:
            self._session_application.add_assistant_message(
                session_id=session_id,
                content=response.content,
                metadata={
                    'agent': response.agent_name,
                    'recovered_from': checkpoint['checkpoint_id'],
                },
            )

        return {
            'checkpoint_id': checkpoint['checkpoint_id'],
            'round': checkpoint['round'],
            'answer': response.content if response.success else None,
            'success': response.success,
            'error': response.error if not response.success else None,
            'agent_name': response.agent_name,
        }

    def list_checkpoints(self, session_id: str, *, agent_name: Optional[str] = None, limit: int = 10) -> dict:
        return {
            'checkpoints': self._checkpoint_manager.list_checkpoints(
                session_id=session_id,
                agent_name=agent_name,
                limit=limit,
            )
        }

    def rollback_and_retry(self, session_id: str, payload: Optional[dict]) -> dict:
        body = payload or {}
        after_seq = int(body.get('after_seq'))
        prepared = self._session_application.prepare_retry(
            session_id=session_id,
            after_seq=after_seq,
            modify_user_message=body.get('modify_user_message'),
        )
        context = self._chat_application.build_context(
            session_id=session_id,
            user_id=body.get('user_id'),
        )
        response = self._chat_application.get_orchestrator().execute(task=prepared['task'], context=context)

        if response.success and response.content:
            self._session_application.add_assistant_message(
                session_id=session_id,
                content=response.content,
                metadata={'agent': response.agent_name},
            )

        return {
            'deleted': prepared['deleted'],
            'answer': response.content if response.success else None,
            'agent_name': response.agent_name if response.success else None,
            'execution_time': getattr(response, 'execution_time', None),
            'success': response.success,
            'error': response.error if not response.success else None,
        }


def get_agent_collaboration_application() -> AgentCollaborationApplication:
    return get_runtime_dependency(container_getter='get_agent_collaboration_application')
