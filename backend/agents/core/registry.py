# -*- coding: utf-8 -*-
"""
智能体注册表 - 管理所有可用的智能体
"""

from typing import Dict, List, Optional
import logging

from .base import BaseAgent

logger = logging.getLogger(__name__)


class AgentRegistry:
    """
    智能体注册表：注册、查找、按能力查找、列出智能体
    """

    def __init__(self):
        self._agents: Dict[str, BaseAgent] = {}
        self.logger = logging.getLogger(self.__class__.__name__)

    def register(self, agent: BaseAgent):
        if agent.name in self._agents:
            raise ValueError(f"智能体 '{agent.name}' 已经注册")
        self._agents[agent.name] = agent
        self.logger.info(f"注册智能体: {agent.name} ({agent.description})")

    def unregister(self, agent_name: str):
        if agent_name in self._agents:
            del self._agents[agent_name]
            self.logger.info(f"注销智能体: {agent_name}")

    def get(self, agent_name: str) -> Optional[BaseAgent]:
        return self._agents.get(agent_name)

    def list_agents(self) -> List[Dict]:
        return [agent.get_info() for agent in self._agents.values()]

    def find_by_capability(self, capability: str) -> List[BaseAgent]:
        return [
            agent for agent in self._agents.values()
            if capability in agent.capabilities
        ]

    def find_capable_agents(self, task: str, context=None) -> List[BaseAgent]:
        capable_agents = []
        for agent in self._agents.values():
            if agent.can_handle(task, context):
                capable_agents.append(agent)
        return capable_agents

    def has_agent(self, agent_name: str) -> bool:
        return agent_name in self._agents

    def count(self) -> int:
        return len(self._agents)

    def clear(self):
        self._agents.clear()
        self.logger.info("已清空所有智能体")

    def __repr__(self) -> str:
        return f"<AgentRegistry(agents={self.count()})>"


_global_registry: Optional[AgentRegistry] = None


def get_registry() -> AgentRegistry:
    global _global_registry
    if _global_registry is None:
        _global_registry = AgentRegistry()
    return _global_registry


def register_agent(agent: BaseAgent):
    get_registry().register(agent)
