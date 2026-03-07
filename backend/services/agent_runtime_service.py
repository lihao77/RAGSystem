# -*- coding: utf-8 -*-
"""
Agent 运行时服务。
"""

from __future__ import annotations

import logging
from typing import Optional

from runtime.dependencies import get_runtime_dependency
from agents import load_agents_from_config
from agents.core.orchestrator import AgentOrchestrator
from agents.core.registry import AgentRegistry
from config import get_config
from model_adapter import get_default_adapter

logger = logging.getLogger(__name__)


class AgentRuntimeService:
    """封装 Orchestrator 的初始化与热重载。"""

    def __init__(self):
        self._orchestrator: Optional[AgentOrchestrator] = None

    def get_orchestrator(self):
        """获取或初始化全局 Orchestrator。"""
        if self._orchestrator is None:
            try:
                system_config = get_config()
                adapter = get_default_adapter()

                self._orchestrator = AgentOrchestrator(
                    model_adapter=adapter,
                    registry=AgentRegistry(),
                )

                from agents import get_config_manager
                from mcp import get_mcp_manager

                agents = load_agents_from_config(
                    model_adapter=adapter,
                    system_config=system_config,
                    orchestrator=self._orchestrator,
                    config_manager=get_config_manager(),
                    mcp_manager_getter=get_mcp_manager,
                )

                for agent_name, agent in agents.items():
                    self._orchestrator.register_agent(agent)
                    logger.info('已注册智能体: %s', agent_name)

                try:
                    from agents.monitoring import MetricsCollector
                    from agents.events import get_session_manager

                    metrics_collector = MetricsCollector()
                    session_manager = get_session_manager()

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
                logger.info('已注册的智能体列表: %s', [agent['name'] for agent in registered_agents])
            except Exception as error:
                logger.error('Orchestrator 初始化失败: %s', error, exc_info=True)
                raise

        return self._orchestrator

    def reload_agents(self) -> bool:
        """重新加载已启用的智能体。"""
        if self._orchestrator is None:
            logger.warning('orchestrator 未初始化，跳过重新加载')
            return False

        try:
            self._orchestrator.registry.clear()
            logger.info('已清空 orchestrator 中的智能体注册')

            system_config = get_config()
            adapter = get_default_adapter()
            from agents import get_config_manager
            from mcp import get_mcp_manager

            agents = load_agents_from_config(
                model_adapter=adapter,
                system_config=system_config,
                orchestrator=self._orchestrator,
                config_manager=get_config_manager(),
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


_agent_runtime_service: Optional[AgentRuntimeService] = None


def get_agent_runtime_service() -> AgentRuntimeService:
    global _agent_runtime_service
    return get_runtime_dependency(
        container_getter='get_agent_runtime_service',
        fallback_name='agent_runtime_service',
        fallback_factory=AgentRuntimeService,
        legacy_getter=lambda: _agent_runtime_service,
        legacy_setter=lambda instance: globals().__setitem__('_agent_runtime_service', instance),
    )
