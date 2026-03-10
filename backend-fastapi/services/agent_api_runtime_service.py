# -*- coding: utf-8 -*-
"""
Agent API 运行时支持服务。

合并了原 AgentRuntimeService（orchestrator 初始化/热重载）和
AgentChatApplication（会话历史、配置访问）的职责。
"""

from __future__ import annotations

import logging
from typing import Optional

from runtime.dependencies import get_runtime_dependency
from agents import AgentContext
from agents.events import get_session_manager
from agents.task_registry import get_task_registry
from services.conversation_store import ConversationStore

logger = logging.getLogger(__name__)


class AgentApiRuntimeService:
    """为 Agent API 路由提供会话存储与 orchestrator 访问。"""

    def __init__(
        self,
        conversation_store: Optional[ConversationStore] = None,
        task_registry_getter=None,
        session_manager_getter=None,
        session_application=None,
        collaboration_application=None,
        config_getter=None,
        config_manager_getter=None,
        default_adapter_getter=None,
    ):
        self._conversation_store = conversation_store or ConversationStore()
        self._task_registry_getter = task_registry_getter or get_task_registry
        self._session_manager_getter = session_manager_getter or get_session_manager
        self._orchestrator = None

        from config import get_config
        from model_adapter import get_default_adapter
        from agents import get_config_manager as get_agent_config_manager

        self._config_getter = config_getter or get_config
        self._config_manager_getter = config_manager_getter or get_agent_config_manager
        self._default_adapter_getter = default_adapter_getter or get_default_adapter

        # 延迟构建 session / collaboration application
        from application.agent_session import AgentSessionApplication
        self._session_application = session_application or AgentSessionApplication(
            conversation_store=self._conversation_store,
        )
        if collaboration_application is not None:
            self._collaboration_application = collaboration_application
        else:
            from application.agent_collaboration import AgentCollaborationApplication
            self._collaboration_application = AgentCollaborationApplication(
                runtime_service=self,
                session_application=self._session_application,
            )

    # ── conversation store ──────────────────────────────

    def get_conversation_store(self) -> ConversationStore:
        return self._conversation_store

    # ── 会话历史（原 AgentChatApplication） ───────────────

    def load_history_into_context(self, context: AgentContext, session_id: str, limit: int = 50) -> None:
        raw_messages = self._conversation_store.get_recent_messages(session_id=session_id, limit=limit)
        for item in raw_messages:
            if item.get('role') not in {'user', 'assistant', 'system'}:
                continue
            context.add_message(
                role=item['role'],
                content=item['content'],
                metadata=dict(item.get('metadata') or {}),
                seq=item.get('seq'),
            )

    def build_context(self, *, session_id: str, user_id: Optional[str] = None, limit: int = 50) -> AgentContext:
        context = AgentContext(session_id=session_id, user_id=user_id)
        self.load_history_into_context(context, session_id=session_id, limit=limit)
        return context

    # ── orchestrator（原 AgentRuntimeService） ───────────

    def get_orchestrator(self):
        if self._orchestrator is None:
            self._init_orchestrator()
        return self._orchestrator

    def _init_orchestrator(self):
        from agents import load_agents_from_config
        from agents.core.orchestrator import AgentOrchestrator
        from agents.core.registry import AgentRegistry
        from mcp import get_mcp_manager

        try:
            system_config = self._config_getter()
            adapter = self._default_adapter_getter()

            self._orchestrator = AgentOrchestrator(
                model_adapter=adapter,
                registry=AgentRegistry(),
            )

            agents = load_agents_from_config(
                model_adapter=adapter,
                system_config=system_config,
                orchestrator=self._orchestrator,
                config_manager=self._config_manager_getter(),
                mcp_manager_getter=get_mcp_manager,
            )

            for agent_name, agent in agents.items():
                self._orchestrator.register_agent(agent)
                logger.info('已注册智能体: %s', agent_name)

            try:
                from agents.monitoring import MetricsCollector

                metrics_collector = MetricsCollector()
                session_manager = self._session_manager_getter()

                self._orchestrator._metrics_collector = metrics_collector
                self._orchestrator._session_manager = session_manager

                logger.info('✓ 性能指标收集器已初始化')
            except Exception as error:
                logger.warning('性能指标收集器初始化失败（不影响核心功能）: %s', error)

            registered_agents = self._orchestrator.list_agents()
            logger.info(
                'Orchestrator 初始化成功，已加载 %s 个智能体，已注册 %s 个智能体',
                len(agents),
                len(registered_agents),
            )
            logger.info('已加载的智能体列表: %s', list(agents.keys()))
            logger.info('已注册的智能体列表: %s', [a['name'] for a in registered_agents])
        except Exception as error:
            logger.error('Orchestrator 初始化失败: %s', error, exc_info=True)
            raise

    def reload_agents(self) -> bool:
        if self._orchestrator is None:
            logger.warning('orchestrator 未初始化，跳过重新加载')
            return False

        try:
            from agents import load_agents_from_config
            from mcp import get_mcp_manager

            self._orchestrator.registry.clear()
            logger.info('已清空 orchestrator 中的智能体注册')

            system_config = self._config_getter()
            adapter = self._default_adapter_getter()

            agents = load_agents_from_config(
                model_adapter=adapter,
                system_config=system_config,
                orchestrator=self._orchestrator,
                config_manager=self._config_manager_getter(),
                mcp_manager_getter=get_mcp_manager,
            )

            for agent_name, agent in agents.items():
                self._orchestrator.register_agent(agent)
                logger.info('已重新注册智能体: %s', agent_name)

            logger.info('智能体重新加载完成，共加载 %s 个智能体', len(agents))
            return True
        except Exception as error:
            logger.error('重新加载智能体失败: %s', error, exc_info=True)
            return False

    # ── 配置访问 ────────────────────────────────────────

    def get_system_config(self):
        return self._config_getter()

    def get_config_manager(self):
        return self._config_manager_getter()

    def get_default_adapter(self):
        return self._default_adapter_getter()

    # ── 任务 / 会话管理 ────────────────────────────────

    def get_task_registry(self):
        return self._task_registry_getter()

    def get_session_manager(self):
        return self._session_manager_getter()

    def get_session_event_bus(self, session_id: str):
        return self.get_session_manager().get_or_create(session_id)

    def get_session_application(self):
        return self._session_application

    def get_collaboration_application(self):
        return self._collaboration_application


def get_agent_api_runtime_service() -> AgentApiRuntimeService:
    return get_runtime_dependency(container_getter='get_agent_api_runtime_service')
