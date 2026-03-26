# -*- coding: utf-8 -*-
"""Agent recovery and replay use cases."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Optional

from agents.recovery import CheckpointManager
from agents.events.session_manager import cleanup_run
from runtime.dependencies import get_runtime_dependency

from .agent_session import AgentSessionApplication, get_agent_session_application

if TYPE_CHECKING:
    from services.agent_api_runtime_service import AgentApiRuntimeService


class AgentCollaborationApplication:
    """Coordinate checkpoint recovery and replay flows."""

    def __init__(
        self,
        *,
        checkpoint_manager: Optional[CheckpointManager] = None,
        runtime_service: Optional['AgentApiRuntimeService'] = None,
        session_application: Optional[AgentSessionApplication] = None,
    ):
        self._checkpoint_manager = checkpoint_manager or CheckpointManager()
        if runtime_service is not None:
            self._runtime_service = runtime_service
        else:
            from services.agent_api_runtime_service import get_agent_api_runtime_service
            self._runtime_service = get_agent_api_runtime_service()
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

        context = self._runtime_service.build_context(
            session_id=session_id,
            user_id=body.get('user_id'),
            limit=0,
            run_id=str(uuid.uuid4()),
        )
        for msg in checkpoint['messages']:
            context.add_message(
                role=msg['role'],
                content=msg['content'],
                metadata=msg.get('metadata', {}),
                seq=msg.get('seq'),
            )

        user_messages = [item for item in checkpoint['messages'] if item['role'] == 'user']
        if not user_messages:
            raise ValueError('检查点中没有用户消息')

        task = user_messages[-1]['content']
        run_id = context.metadata.get('run_id')
        routed_agent = self._runtime_service.get_agent_execution_service().resolve_routed_root_agent(
            task=task,
            session_id=session_id,
            preferred_agent=checkpoint['agent_name'],
            user_id=body.get('user_id'),
        )
        try:
            response = routed_agent.execute(task, context)
        finally:
            if run_id:
                cleanup_run(run_id)

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
        agent_execution_service = self._runtime_service.get_agent_execution_service()
        invocation = agent_execution_service.invoke_routed_agent(
            task=prepared['task'],
            session_id=session_id,
            user_id=body.get('user_id'),
            run_id=str(uuid.uuid4()),
            entrypoint='rollback_and_retry',
            source='api',
            persist_user_message=False,
            persist_final_answer=False,
            visible_to_user=True,
        )
        response = invocation.response

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
