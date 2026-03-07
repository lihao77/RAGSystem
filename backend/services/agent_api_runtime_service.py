# -*- coding: utf-8 -*-
"""
Agent API 运行时支持服务。
"""

from __future__ import annotations

from runtime.dependencies import get_runtime_dependency
from typing import Optional

from agents import AgentContext, get_config_manager as get_agent_config_manager
from agents.events import get_session_manager
from agents.task_registry import get_task_registry
from config import get_config
from model_adapter import get_default_adapter
from conversation_store import ConversationStore

from .agent_runtime_service import get_agent_runtime_service


class AgentApiRuntimeService:
    """为 Agent API 路由提供会话存储与 orchestrator 访问。"""

    def __init__(
        self,
        conversation_store: Optional[ConversationStore] = None,
        runtime_service=None,
        config_getter=None,
        config_manager_getter=None,
        task_registry_getter=None,
        session_manager_getter=None,
        default_adapter_getter=None,
    ):
        self._conversation_store = conversation_store or ConversationStore()
        self._runtime_service = runtime_service or get_agent_runtime_service()
        self._config_getter = config_getter or get_config
        self._config_manager_getter = config_manager_getter or get_agent_config_manager
        self._task_registry_getter = task_registry_getter or get_task_registry
        self._session_manager_getter = session_manager_getter or get_session_manager
        self._default_adapter_getter = default_adapter_getter or get_default_adapter

    def get_conversation_store(self) -> ConversationStore:
        return self._conversation_store

    def load_history_into_context(self, context: AgentContext, session_id: str, limit: int = 50) -> None:
        raw_messages = self._conversation_store.get_recent_messages(session_id=session_id, limit=limit)

        for item in raw_messages:
            if item.get('role') in ['user', 'assistant', 'system']:
                metadata = dict(item.get('metadata') or {})
                if item.get('seq') is not None:
                    metadata['seq'] = item['seq']
                context.add_message(role=item['role'], content=item['content'], metadata=metadata)

    def get_orchestrator(self):
        return self._runtime_service.get_orchestrator()

    def reload_agents(self):
        return self._runtime_service.reload_agents()

    def get_system_config(self):
        return self._config_getter()

    def get_config_manager(self):
        return self._config_manager_getter()

    def get_task_registry(self):
        return self._task_registry_getter()

    def get_session_manager(self):
        return self._session_manager_getter()

    def get_session_event_bus(self, session_id: str):
        return self.get_session_manager().get_or_create(session_id)

    def get_default_adapter(self):
        return self._default_adapter_getter()


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
