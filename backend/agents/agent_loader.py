# -*- coding: utf-8 -*-
"""
智能体动态加载器

支持从配置文件动态加载和创建智能体实例
"""

import logging
from typing import Dict, Optional, Type
from .base import BaseAgent
from .master_agent import MasterAgent
from .generic_agent import GenericAgent
from .react_agent import ReActAgent
from .config_manager import get_config_manager

logger = logging.getLogger(__name__)


# 智能体类型注册表
AGENT_TYPES: Dict[str, Type[BaseAgent]] = {
    'master': MasterAgent,
    'generic': GenericAgent,
    'react': ReActAgent,
}


def register_agent_type(type_name: str, agent_class: Type[BaseAgent]):
    """
    注册新的智能体类型

    Args:
        type_name: 类型名称
        agent_class: 智能体类
    """
    AGENT_TYPES[type_name] = agent_class
    logger.info(f"已注册智能体类型: {type_name} -> {agent_class.__name__}")


class AgentLoader:
    """
    智能体加载器

    负责从配置文件动态加载智能体实例
    """

    def __init__(self, llm_adapter, system_config, orchestrator=None):
        """
        初始化加载器

        Args:
            llm_adapter: LLM 适配器
            system_config: 系统配置
            orchestrator: 编排器（可选，MasterAgent 需要）
        """
        self.llm_adapter = llm_adapter
        self.system_config = system_config
        self.orchestrator = orchestrator
        self.config_manager = get_config_manager()

    def load_agent(self, agent_name: str) -> Optional[BaseAgent]:
        """
        加载单个智能体

        Args:
            agent_name: 智能体名称

        Returns:
            智能体实例，如果加载失败返回 None
        """
        try:
            # 获取智能体配置
            agent_config = self.config_manager.get_config(agent_name)
            if agent_config is None:
                logger.warning(f"智能体 '{agent_name}' 配置不存在")
                return None

            # 检查是否启用
            if not agent_config.enabled:
                logger.info(f"智能体 '{agent_name}' 已禁用")
                return None

            # 确定智能体类型
            agent_type = self._get_agent_type(agent_name, agent_config)

            # 获取智能体类
            agent_class = AGENT_TYPES.get(agent_type)
            if agent_class is None:
                logger.error(f"未知的智能体类型: {agent_type}")
                return None

            # 创建智能体实例
            agent = self._create_agent_instance(
                agent_class,
                agent_name,
                agent_config
            )

            logger.info(f"成功加载智能体: {agent_name} (类型: {agent_type})")
            return agent

        except Exception as e:
            logger.error(f"加载智能体 '{agent_name}' 失败: {e}", exc_info=True)
            return None

    def load_all_agents(self) -> Dict[str, BaseAgent]:
        """
        加载所有启用的智能体

        Returns:
            智能体字典 {agent_name: agent_instance}
        """
        agents = {}
        all_configs = self.config_manager.get_all_configs()

        # 1. 加载用户配置的智能体
        for agent_name, agent_config in all_configs.items():
            # 跳过 MasterAgent（由系统单独加载）
            if agent_name == 'master_agent':
                logger.info(f"跳过 master_agent（系统智能体，不从配置加载）")
                continue

            agent = self.load_agent(agent_name)
            if agent is not None:
                agents[agent_name] = agent

        # 2. 强制加载 MasterAgent（系统级智能体）
        master_agent = self._load_system_master_agent()
        if master_agent is not None:
            agents['master_agent'] = master_agent
            logger.info("✅ 已加载系统智能体: master_agent（不可配置）")

        logger.info(f"成功加载 {len(agents)} 个智能体")
        return agents

    def _load_system_master_agent(self) -> Optional[BaseAgent]:
        """
        加载系统级 MasterAgent（硬编码配置，不受用户控制）

        MasterAgent 是系统核心组件，负责任务分解和智能体协调，
        其配置不应暴露给用户修改。

        Returns:
            MasterAgent 实例
        """
        try:
            if self.orchestrator is None:
                logger.warning("orchestrator 未提供，无法加载 MasterAgent")
                return None

            from .master_agent import MasterAgent
            from .agent_config import AgentConfig, AgentLLMConfig

            # 硬编码的 MasterAgent 配置
            # provider 和 model_name 留空，使用系统配置作为兜底
            master_config = AgentConfig(
                agent_name='master_agent',
                display_name='主协调智能体',
                description='主协调智能体，负责任务分析、分解和结果整合',
                enabled=True,
                llm=AgentLLMConfig(
                    provider=None,  # 使用系统配置
                    model_name=None,  # 使用系统配置
                    temperature=0.0,  # 任务分析需要极高确定性
                    max_tokens=2000,
                    timeout=30,
                    retry_attempts=3
                ),
                custom_params={
                    'analysis_temperature': 0.0,
                    'synthesis_temperature': 0.3
                }
            )

            # 创建 MasterAgent 实例
            master_agent = MasterAgent(
                llm_adapter=self.llm_adapter,
                orchestrator=self.orchestrator,
                agent_config=master_config,
                system_config=self.system_config
            )

            logger.info("MasterAgent 已创建（系统级配置）")
            return master_agent

        except Exception as e:
            logger.error(f"加载 MasterAgent 失败: {e}", exc_info=True)
            return None

    def _get_agent_type(self, agent_name: str, agent_config) -> str:
        """
        确定智能体类型

        Args:
            agent_name: 智能体名称
            agent_config: 智能体配置

        Returns:
            智能体类型字符串
        """
        # 1. 从 custom_params 中获取 type
        if hasattr(agent_config, 'custom_params'):
            agent_type = agent_config.custom_params.get('type')
            if agent_type:
                return agent_type

        # 2. 根据名称推断（向后兼容）
        if agent_name == 'master_agent':
            return 'master'

        # 3. 默认使用通用类型
        logger.warning(f"智能体 '{agent_name}' 未指定 type，默认使用 'generic'")
        return 'generic'

    def _create_agent_instance(
        self,
        agent_class: Type[BaseAgent],
        agent_name: str,
        agent_config
    ) -> BaseAgent:
        """
        创建智能体实例

        Args:
            agent_class: 智能体类
            agent_name: 智能体名称
            agent_config: 智能体配置

        Returns:
            智能体实例
        """
        # 准备通用参数
        common_kwargs = {
            'llm_adapter': self.llm_adapter,
            'agent_config': agent_config,
            'system_config': self.system_config
        }

        # 根据不同类型添加特殊参数
        if agent_class == MasterAgent:
            # MasterAgent 需要 orchestrator
            if self.orchestrator is None:
                raise ValueError("MasterAgent 需要 orchestrator 参数")
            common_kwargs['orchestrator'] = self.orchestrator

        elif agent_class == GenericAgent:
            # GenericAgent 需要额外参数
            common_kwargs.update({
                'agent_name': agent_config.agent_name,
                'display_name': agent_config.display_name,
                'description': agent_config.description,
                'behavior_config': agent_config.custom_params.get('behavior', {})
            })

        elif agent_class == ReActAgent:
            # ReActAgent 需要额外参数
            from tools.function_definitions import get_tool_definitions

            # 获取所有工具
            all_tools = get_tool_definitions()

            # 根据配置过滤工具（与 GenericAgent 保持一致）
            if agent_config and agent_config.tools and agent_config.tools.enabled_tools:
                enabled_tools = agent_config.tools.enabled_tools
                filtered_tools = [
                    tool for tool in all_tools
                    if tool.get('function', {}).get('name') in enabled_tools
                ]
                logger.info(f"{agent_config.agent_name} 已根据配置过滤工具，启用: {enabled_tools}")
            else:
                filtered_tools = all_tools
                logger.info(f"{agent_config.agent_name} 启用所有工具")

            common_kwargs.update({
                'agent_name': agent_config.agent_name,
                'display_name': agent_config.display_name,
                'description': agent_config.description,
                'available_tools': filtered_tools
            })

        # 创建实例
        return agent_class(**common_kwargs)


def load_agents_from_config(llm_adapter, system_config, orchestrator=None) -> Dict[str, BaseAgent]:
    """
    从配置文件加载所有智能体（便捷函数）

    Args:
        llm_adapter: LLM 适配器
        system_config: 系统配置
        orchestrator: 编排器（可选）

    Returns:
        智能体字典
    """
    loader = AgentLoader(llm_adapter, system_config, orchestrator)
    return loader.load_all_agents()
