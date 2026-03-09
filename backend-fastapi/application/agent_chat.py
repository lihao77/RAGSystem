# -*- coding: utf-8 -*-
"""Agent chat orchestration use cases."""

from __future__ import annotations

from typing import Optional

from agents import AgentContext, get_config_manager as get_agent_config_manager
from services.conversation_store import ConversationStore
from config import get_config
from model_adapter import get_default_adapter
from runtime.dependencies import get_runtime_dependency
from services.agent_runtime_service import get_agent_runtime_service


class AgentChatApplication:
    """Coordinate chat-oriented agent runtime use cases."""

    def __init__(
        self,
        *,
        conversation_store: Optional[ConversationStore] = None,
        runtime_service=None,
        config_getter=None,
        config_manager_getter=None,
        default_adapter_getter=None,
    ):
        self._conversation_store = conversation_store or ConversationStore()
        self._runtime_service = runtime_service or get_agent_runtime_service()
        self._config_getter = config_getter or get_config
        self._config_manager_getter = config_manager_getter or get_agent_config_manager
        self._default_adapter_getter = default_adapter_getter or get_default_adapter

    def get_conversation_store(self) -> ConversationStore:
        return self._conversation_store

    def load_history_into_context(self, context: AgentContext, session_id: str, limit: int = 50) -> None:
        raw_messages = self._conversation_store.get_recent_messages(session_id=session_id, limit=limit)
        for item in raw_messages:
            if item.get('role') not in {'user', 'assistant', 'system'}:
                continue
            metadata = dict(item.get('metadata') or {})
            if item.get('seq') is not None:
                metadata['seq'] = item['seq']
            context.add_message(role=item['role'], content=item['content'], metadata=metadata)

    def build_context(self, *, session_id: str, user_id: Optional[str] = None, limit: int = 50) -> AgentContext:
        context = AgentContext(session_id=session_id, user_id=user_id)
        self.load_history_into_context(context, session_id=session_id, limit=limit)
        return context

    def get_orchestrator(self):
        return self._runtime_service.get_orchestrator()

    def reload_agents(self):
        return self._runtime_service.reload_agents()

    def get_system_config(self):
        return self._config_getter()

    def get_config_manager(self):
        return self._config_manager_getter()

    def get_default_adapter(self):
        return self._default_adapter_getter()


def get_agent_chat_application() -> AgentChatApplication:
    return get_runtime_dependency(container_getter='get_agent_chat_application')
