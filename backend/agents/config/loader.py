# -*- coding: utf-8 -*-
"""
智能体动态加载器

支持从配置文件动态加载和创建智能体实例
"""

import logging
from typing import Dict, Optional, Type
from agents.core import BaseAgent
from agents.implementations import ReActAgent
from .manager import get_config_manager
from agents.tools.builtin import SKILLS_SYSTEM_TOOLS as _SKILLS_SYSTEM_TOOLS

logger = logging.getLogger(__name__)


# 智能体类型注册表
AGENT_TYPES: Dict[str, Type[BaseAgent]] = {
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

    def __init__(self, model_adapter, system_config, orchestrator=None, config_manager=None, mcp_manager_getter=None):
        """
        初始化加载器

        Args:
            model_adapter: Model 适配器
            system_config: 系统配置
            orchestrator: 编排器（MasterAgent V2 需要）
        """
        self.model_adapter = model_adapter
        self.system_config = system_config
        self.orchestrator = orchestrator
        self.config_manager = config_manager or get_config_manager()
        self._mcp_manager_getter = mcp_manager_getter

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
            # 跳过 MasterAgent V2（由系统单独加载）
            if agent_name == 'master_agent_v2':
                logger.info(f"跳过 {agent_name}（系统智能体，不从配置加载）")
                continue

            agent = self.load_agent(agent_name)
            if agent is not None:
                agents[agent_name] = agent

        # 2. 强制加载 MasterAgent V2（系统级智能体）
        master_agent_v2 = self._load_system_master_agent_v2()
        if master_agent_v2 is not None:
            agents['master_agent_v2'] = master_agent_v2
            logger.info(f"✅ 已加载系统智能体: master_agent_v2（支持通过 agent_configs.yaml 配置）")

        logger.info(f"成功加载 {len(agents)} 个智能体")
        return agents

    def _load_system_master_agent_v2(self) -> Optional[BaseAgent]:
        """
        加载系统级 MasterAgent V2

        优先从 agent_configs.yaml 读取 master_agent_v2 配置；
        如果用户未配置，则使用硬编码默认值兜底。

        Returns:
            MasterAgent V2 实例
        """
        try:
            if self.orchestrator is None:
                logger.warning("orchestrator 未提供，无法加载 MasterAgent V2")
                return None

            from .models import AgentConfig, AgentLLMConfig

            # 尝试从 YAML 读取用户配置
            yaml_config = self.config_manager.get_config('master_agent_v2')
            if yaml_config is not None:
                # 用户有配置：直接使用（Pydantic 已验证字段默认值）
                # 注意：忽略 enabled 字段，Master Agent 作为系统级智能体始终加载
                master_v2_config = yaml_config
                logger.info("MasterAgent V2：使用 agent_configs.yaml 中的用户配置")
            else:
                # 用户无配置：使用硬编码默认值兜底
                master_v2_config = AgentConfig(
                    agent_name='master_agent_v2',
                    display_name='Master Agent V2 (动态编排)',
                    description='动态智能体编排器，将 Agent 当作工具使用，通过 ReAct 模式实时决策',
                    enabled=True,
                    llm=AgentLLMConfig(
                        provider=None,  # 使用系统配置
                        model_name=None,  # 使用系统配置
                        temperature=0.3,
                        max_tokens=4096,
                        timeout=60,
                        retry_attempts=3
                    ),
                    custom_params={
                        'type': 'master_v2',
                        'behavior': {
                            'system_prompt': '你是一个智能体编排器，可以动态调用其他 Agent 完成复杂任务。',
                            'max_rounds': 15,
                            'compression_trigger_ratio': 0.85,
                            'summarize_max_tokens': 300,
                            'preserve_recent_turns': 3,
                            'data_save_dir': './static/temp_data'
                        }
                    }
                )
                logger.info("MasterAgent V2：未在 agent_configs.yaml 中找到配置，使用硬编码默认值")

            # 解析工具与 Skills 配置（复用公共方法）
            available_tools, available_skills = self._resolve_tools_and_skills(master_v2_config)

            from agents.implementations.master import MasterAgentV2
            master_agent_v2 = MasterAgentV2(
                orchestrator=self.orchestrator,
                model_adapter=self.model_adapter,
                agent_config=master_v2_config,
                system_config=self.system_config,
                available_tools=available_tools,
                available_skills=available_skills,
            )
            logger.info(
                f"MasterAgent V2 已创建（新版动态编排架构），"
                f"直接工具: {len(available_tools)} 个，Skills: {len(available_skills)} 个"
            )

            return master_agent_v2

        except ImportError as e:
            logger.error(f"MasterAgent V2 模块未找到，请确认已正确安装: {e}")
            return None
        except Exception as e:
            logger.error(f"加载 MasterAgent V2 失败: {e}", exc_info=True)
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

        # 2. 默认使用 react 类型
        logger.warning(f"智能体 '{agent_name}' 未指定 type，默认使用 'react'")
        return 'react'

    # ─── Skills 系统工具定义（供 _resolve_tools_and_skills 使用）───────────────
    # 定义在 agents/tools/builtin.py，顶部已导入为 _SKILLS_SYSTEM_TOOLS
    _SKILLS_SYSTEM_TOOLS = _SKILLS_SYSTEM_TOOLS

    def _resolve_tools_and_skills(self, agent_config):
        """
        根据 agent_config 过滤工具列表并注入 Skills 工具

        Returns:
            (available_tools, available_skills) 元组
        """
        from tools.function_definitions import get_tool_definitions
        from agents.skills.skill_loader import get_skill_loader

        # 1. 工具过滤
        all_tools = get_tool_definitions()
        if agent_config and agent_config.tools and agent_config.tools.enabled_tools:
            enabled_tools = agent_config.tools.enabled_tools
            filtered_tools = [
                tool for tool in all_tools
                if tool.get('function', {}).get('name') in enabled_tools
            ]
            logger.info(f"{agent_config.agent_name} 启用工具: {enabled_tools}")
        else:
            filtered_tools = []
            logger.info(f"{agent_config.agent_name} 未配置工具或配置为空列表，不启用任何工具")

        # 2. Skills 过滤
        skill_loader = get_skill_loader()
        all_skills = skill_loader.load_all_skills()
        filtered_skills = []

        if agent_config and agent_config.skills and agent_config.skills.enabled_skills:
            enabled_skill_names = agent_config.skills.enabled_skills
            filtered_skills = [
                skill for skill in all_skills
                if skill.name in enabled_skill_names
            ]
            logger.info(f"{agent_config.agent_name} 已根据配置过滤 Skills，启用: {enabled_skill_names}")

            # 3. 如果 auto_inject=True，自动追加 Skills 系统工具
            auto_inject = agent_config.skills.auto_inject if agent_config.skills else True
            if auto_inject:
                existing_tool_names = {t.get('function', {}).get('name') for t in filtered_tools}
                for skill_tool in self._SKILLS_SYSTEM_TOOLS:
                    tool_name = skill_tool.get('function', {}).get('name')
                    if tool_name not in existing_tool_names:
                        filtered_tools.append(skill_tool)
                        logger.info(f"  → 自动注入 Skills 系统工具: {tool_name}")
        else:
            logger.info(f"{agent_config.agent_name} 未配置 Skills，不加载任何 Skill")

        # 4. MCP 工具注入
        mcp_config = getattr(agent_config, 'mcp', None)
        if mcp_config and getattr(mcp_config, 'enabled_servers', None):
            try:
                manager_getter = self._mcp_manager_getter
                if manager_getter is None:
                    from mcp import get_mcp_manager
                    manager_getter = get_mcp_manager
                manager = manager_getter()
                injected_count = 0
                for server_name in mcp_config.enabled_servers:
                    mcp_tools = manager.get_tools_openai_format(server_name)
                    if mcp_tools:
                        filtered_tools.extend(mcp_tools)
                        injected_count += len(mcp_tools)
                        logger.info(
                            f"  → {agent_config.agent_name} 注入 MCP 工具 "
                            f"({server_name}): {len(mcp_tools)} 个"
                        )
                    else:
                        logger.warning(
                            f"  ⚠ MCP Server '{server_name}' 未连接或无工具，"
                            f"智能体 {agent_config.agent_name} 的该 Server 工具跳过"
                        )
                if injected_count:
                    logger.info(
                        f"{agent_config.agent_name} 共注入 {injected_count} 个 MCP 工具"
                    )
            except Exception as e:
                logger.warning(f"注入 MCP 工具失败（{agent_config.agent_name}）: {e}")

        return filtered_tools, filtered_skills

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
            'model_adapter': self.model_adapter,
            'agent_config': agent_config,
            'system_config': self.system_config
        }

        # 根据不同类型添加特殊参数
        if agent_class == ReActAgent:
            # ReActAgent 需要额外参数：使用公共方法解析工具与 Skills
            filtered_tools, filtered_skills = self._resolve_tools_and_skills(agent_config)

            common_kwargs.update({
                'agent_name': agent_config.agent_name,
                'display_name': agent_config.display_name,
                'description': agent_config.description,
                'available_tools': filtered_tools,
                'available_skills': filtered_skills
            })

        # 创建实例
        return agent_class(**common_kwargs)


def load_agents_from_config(
    model_adapter,
    system_config,
    orchestrator=None,
    config_manager=None,
    mcp_manager_getter=None,
) -> Dict[str, BaseAgent]:
    """
    从配置文件加载所有智能体（便捷函数）

    Args:
        model_adapter: Model 适配器
        system_config: 系统配置
        orchestrator: 编排器（可选）
        config_manager: 已解析的配置管理器（可选）
        mcp_manager_getter: MCP 管理器 getter（可选）

    Returns:
        智能体字典
    """
    loader = AgentLoader(
        model_adapter,
        system_config,
        orchestrator,
        config_manager=config_manager,
        mcp_manager_getter=mcp_manager_getter,
    )
    return loader.load_all_agents()
