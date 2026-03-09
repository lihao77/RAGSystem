# -*- coding: utf-8 -*-
"""
Agent API 运行时支持服务。
"""

from __future__ import annotations

from runtime.dependencies import get_runtime_dependency
from typing import Optional

from application import (
    AgentChatApplication,
    AgentCollaborationApplication,
    AgentSessionApplication,
)
from agents import AgentContext
from agents.events import get_session_manager
from agents.task_registry import get_task_registry
from conversation_store import ConversationStore


class AgentApiRuntimeService:
    """为 Agent API 路由提供会话存储与 orchestrator 访问。"""

    def __init__(
        self,
        conversation_store: Optional[ConversationStore] = None,
        task_registry_getter=None,
        session_manager_getter=None,
        chat_application=None,
        session_application=None,
        collaboration_application=None,
    ):
        self._conversation_store = conversation_store or ConversationStore()
        self._task_registry_getter = task_registry_getter or get_task_registry
        self._session_manager_getter = session_manager_getter or get_session_manager
        self._chat_application = chat_application or AgentChatApplication(conversation_store=self._conversation_store)
        self._session_application = session_application or AgentSessionApplication(conversation_store=self._conversation_store)
        self._collaboration_application = collaboration_application or AgentCollaborationApplication(
            chat_application=self._chat_application,
            session_application=self._session_application,
        )

    def get_conversation_store(self) -> ConversationStore:
        return self._chat_application.get_conversation_store()

    def load_history_into_context(self, context: AgentContext, session_id: str, limit: int = 50) -> None:
        self._chat_application.load_history_into_context(context, session_id=session_id, limit=limit)

    def get_orchestrator(self):
        return self._chat_application.get_orchestrator()

    def reload_agents(self):
        return self._chat_application.reload_agents()

    def get_system_config(self):
        return self._chat_application.get_system_config()

    def get_config_manager(self):
        return self._chat_application.get_config_manager()

    def get_task_registry(self):
        return self._task_registry_getter()

    def get_session_manager(self):
        return self._session_manager_getter()

    def get_session_event_bus(self, session_id: str):
        return self.get_session_manager().get_or_create(session_id)

    def get_default_adapter(self):
        return self._chat_application.get_default_adapter()

    def get_chat_application(self):
        return self._chat_application

    def get_session_application(self):
        return self._session_application

    def get_collaboration_application(self):
        return self._collaboration_application


_agent_api_runtime_service: Optional[AgentApiRuntimeService] = None



def get_agent_api_runtime_service() -> AgentApiRuntimeService:
    global _agent_api_runtime_service
    return get_runtime_dependency(
        container_getter='get_agent_api_runtime_service',
        fallback_name='agent_api_runtime_service',
        fallback_factory=AgentApiRuntimeService,
        require_container=True,
        legacy_getter=lambda: _agent_api_runtime_service,
        legacy_setter=lambda instance: globals().__setitem__('_agent_api_runtime_service', instance),
    )
