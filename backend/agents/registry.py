# -*- coding: utf-8 -*-
"""
智能体注册表 - 管理所有可用的智能体
"""

from typing import Dict, List, Optional
from .base import BaseAgent
import logging

logger = logging.getLogger(__name__)


class AgentRegistry:
    """
    智能体注册表

    功能：
    1. 注册和管理智能体
    2. 按名称查找智能体
    3. 按能力查找智能体
    4. 列出所有可用智能体
    """

    def __init__(self):
        self._agents: Dict[str, BaseAgent] = {}
        self.logger = logging.getLogger(self.__class__.__name__)

    def register(self, agent: BaseAgent):
        """
        注册智能体

        Args:
            agent: 智能体实例

        Raises:
            ValueError: 如果智能体名称已存在
        """
        if agent.name in self._agents:
            raise ValueError(f"智能体 '{agent.name}' 已经注册")

        self._agents[agent.name] = agent
        self.logger.info(f"注册智能体: {agent.name} ({agent.description})")

    def unregister(self, agent_name: str):
        """
        注销智能体

        Args:
            agent_name: 智能体名称
        """
        if agent_name in self._agents:
            del self._agents[agent_name]
            self.logger.info(f"注销智能体: {agent_name}")

    def get(self, agent_name: str) -> Optional[BaseAgent]:
        """
        获取智能体实例

        Args:
            agent_name: 智能体名称

        Returns:
            智能体实例，如果不存在返回 None
        """
        return self._agents.get(agent_name)

    def list_agents(self) -> List[Dict]:
        """
        列出所有已注册的智能体

        Returns:
            智能体信息列表
        """
        return [agent.get_info() for agent in self._agents.values()]

    def find_by_capability(self, capability: str) -> List[BaseAgent]:
        """
        根据能力查找智能体

        Args:
            capability: 能力名称

        Returns:
            具有该能力的智能体列表
        """
        return [
            agent for agent in self._agents.values()
            if capability in agent.capabilities
        ]

    def find_capable_agents(self, task: str, context = None) -> List[BaseAgent]:
        """
        查找能够处理指定任务的智能体

        Args:
            task: 任务描述
            context: 上下文（可选）

        Returns:
            能够处理该任务的智能体列表
        """
        capable_agents = []
        for agent in self._agents.values():
            if agent.can_handle(task, context):
                capable_agents.append(agent)

        return capable_agents

    def has_agent(self, agent_name: str) -> bool:
        """
        检查智能体是否已注册

        Args:
            agent_name: 智能体名称

        Returns:
            True 表示已注册，False 表示未注册
        """
        return agent_name in self._agents

    def count(self) -> int:
        """获取已注册智能体数量"""
        return len(self._agents)

    def clear(self):
        """清空所有已注册的智能体"""
        self._agents.clear()
        self.logger.info("已清空所有智能体")

    def __repr__(self) -> str:
        return f"<AgentRegistry(agents={self.count()})>"


# 全局单例
_global_registry: Optional[AgentRegistry] = None


def get_registry() -> AgentRegistry:
    """
    获取全局智能体注册表

    Returns:
        AgentRegistry 单例
    """
    global _global_registry
    if _global_registry is None:
        _global_registry = AgentRegistry()
    return _global_registry


def register_agent(agent: BaseAgent):
    """
    注册智能体到全局注册表

    Args:
        agent: 智能体实例
    """
    registry = get_registry()
    registry.register(agent)
