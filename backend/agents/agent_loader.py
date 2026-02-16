# -*- coding: utf-8 -*-
"""
智能体动态加载器

支持从配置文件动态加载和创建智能体实例
"""

import logging
from typing import Dict, Optional, Type
from .base import BaseAgent
from .react_agent import ReActAgent
from .config_manager import get_config_manager

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

    def __init__(self, model_adapter, system_config, orchestrator=None):
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
            logger.info(f"✅ 已加载系统智能体: master_agent_v2（不可配置）")

        logger.info(f"成功加载 {len(agents)} 个智能体")
        return agents

    def _load_system_master_agent_v2(self) -> Optional[BaseAgent]:
        """
        加载系统级 MasterAgent V2（硬编码配置，不受用户控制）

        MasterAgent V2 支持并行执行、DAG 编排、失败重试等高级特性。

        Returns:
            MasterAgent V2 实例
        """
        try:
            if self.orchestrator is None:
                logger.warning("orchestrator 未提供，无法加载 MasterAgent V2")
                return None

            from .agent_config import AgentConfig, AgentLLMConfig

            # 硬编码的 MasterAgent V2 配置
            # 新版 Master V2: 将 Agent 当作工具，通过 ReAct 模式动态调用
            master_v2_config = AgentConfig(
                agent_name='master_agent_v2',
                display_name='Master Agent V2 (动态编排)',
                description='动态智能体编排器，将 Agent 当作工具使用，通过 ReAct 模式实时决策',
                enabled=True,
                llm=AgentLLMConfig(
                    provider=None,  # 使用系统配置
                    model_name=None,  # 使用系统配置
                    temperature=0.3,  # ReAct 模式需要一定的灵活性
                    max_tokens=4096,  # 需要更大的上下文
                    timeout=60,
                    retry_attempts=3
                ),
                custom_params={
                    'type': 'master_v2',
                    'behavior': {
                        'system_prompt': '你是一个智能体编排器，可以动态调用其他 Agent 完成复杂任务。',
                        'max_rounds': 15,  # ReAct 循环的最大轮数
                        'max_history_turns': 15,
                        'max_context_tokens': 10000,  # 🎯 增大上下文预算（原 2400 → 10000）

                        # 🎯 智能上下文管理配置
                        'compression_strategy': 'smart',         # 启用智能压缩（原 'sliding_window'）
                        'preserve_tool_results': True,           # 保留工具调用结果（Agent 调用结果）
                        'preserve_recent_turns': 3,              # 保留最近 3 轮对话
                        'importance_threshold': 0.5,             # 重要性阈值

                        'data_save_dir': './static/temp_data'
                    }
                }
            )

            from .master_agent_v2.master_v2 import MasterAgentV2
            master_agent_v2 = MasterAgentV2(
                orchestrator=self.orchestrator,
                model_adapter=self.model_adapter,
                agent_config=master_v2_config,
                system_config=self.system_config
            )
            logger.info("MasterAgent V2 已创建（新版动态编排架构）")

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
            # ReActAgent 需要额外参数
            from tools.function_definitions import get_tool_definitions
            from .skills.skill_loader import get_skill_loader

            # 获取所有工具
            all_tools = get_tool_definitions()

            # 根据配置过滤工具
            if agent_config and agent_config.tools and agent_config.tools.enabled_tools:
                # 配置了具体工具列表
                enabled_tools = agent_config.tools.enabled_tools
                filtered_tools = [
                    tool for tool in all_tools
                    if tool.get('function', {}).get('name') in enabled_tools
                ]
                logger.info(f"{agent_config.agent_name} 启用工具: {enabled_tools}")
            else:
                # 空列表或未配置，不启用任何工具
                filtered_tools = []
                logger.info(f"{agent_config.agent_name} 未配置工具或配置为空列表，不启用任何工具")

            # 加载 Skills（根据配置过滤）
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

                # 🔧 自动注入 Skills 系统工具（内置能力，无需用户配置）
                skill_tools = [
                    {
                        "type": "function",
                        "function": {
                            "name": "activate_skill",
                            "description": """激活一个 Skill 并加载其主文件内容（SKILL.md）。

**使用时机**：
- 当你判断用户任务匹配某个 Skill 的适用场景时，首先激活该 Skill
- 激活后你将获得该 Skill 的完整指导流程和工作方法

**效果**：
- 加载 SKILL.md 主文件内容
- 系统记录该 Skill 已激活，便于上下文管理
- 返回 Skill 的完整指导内容

**后续操作**：
- 根据主文件中的提示，使用 `load_skill_resource` 加载详细文档
- 根据主文件中的指示，使用 `execute_skill_script` 执行脚本

**重要**：每个任务通常只需激活一个 Skill。如果需要切换到不同的 Skill，再次调用此工具。""",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "skill_name": {
                                        "type": "string",
                                        "description": "要激活的 Skill 名称，例如：'disaster-report-example'"
                                    }
                                },
                                "required": ["skill_name"]
                            }
                        }
                    },
                    {
                        "type": "function",
                        "function": {
                            "name": "load_skill_resource",
                            "description": """加载 Skill 的引用文件内容（Additional Resources）。

**前置条件**：
- 你需要先使用 `activate_skill` 激活 Skill
- 然后根据主文件（SKILL.md）中的提示，加载详细的引用文件

**使用场景**：
- 当主文件提到某个引用文件时（如 [report-template.md](report-template.md)）
- 需要查看详细的模板、指南、示例等

**重要**：此工具用于加载**额外的引用文件**，不是主文件。主文件通过 `activate_skill` 加载。""",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "skill_name": {
                                        "type": "string",
                                        "description": "Skill 名称"
                                    },
                                    "resource_file": {
                                        "type": "string",
                                        "description": "要加载的引用文件名，例如：'report-template.md'、'advanced-analysis.md'"
                                    }
                                },
                                "required": ["skill_name", "resource_file"]
                            }
                        }
                    },
                    {
                        "type": "function",
                        "function": {
                            "name": "execute_skill_script",
                            "description": "执行 Skill 的实用脚本（零上下文执行）。只返回脚本的输出结果，不加载代码到上下文。",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "skill_name": {
                                        "type": "string",
                                        "description": "Skill 名称"
                                    },
                                    "script_name": {
                                        "type": "string",
                                        "description": "脚本文件名，例如：'validate_data.py'"
                                    },
                                    "arguments": {
                                        "type": "array",
                                        "description": "传递给脚本的命令行参数（可选）",
                                        "items": {"type": "string"}
                                    }
                                },
                                "required": ["skill_name", "script_name"]
                            }
                        }
                    }
                ]

                # 自动添加到工具列表（避免重复）
                existing_tool_names = {t.get('function', {}).get('name') for t in filtered_tools}
                for skill_tool in skill_tools:
                    tool_name = skill_tool.get('function', {}).get('name')
                    if tool_name not in existing_tool_names:
                        filtered_tools.append(skill_tool)
                        logger.info(f"  → 自动注入 Skills 系统工具: {tool_name}")
            else:
                logger.info(f"{agent_config.agent_name} 未配置 Skills，不加载任何 Skill")

            common_kwargs.update({
                'agent_name': agent_config.agent_name,
                'display_name': agent_config.display_name,
                'description': agent_config.description,
                'available_tools': filtered_tools,
                'available_skills': filtered_skills  # 新增：传递 Skills
            })

        # 创建实例
        return agent_class(**common_kwargs)


def load_agents_from_config(
    model_adapter,
    system_config,
    orchestrator=None
) -> Dict[str, BaseAgent]:
    """
    从配置文件加载所有智能体（便捷函数）

    Args:
        model_adapter: Model 适配器
        system_config: 系统配置
        orchestrator: 编排器（可选）

    Returns:
        智能体字典
    """
    loader = AgentLoader(model_adapter, system_config, orchestrator)
    return loader.load_all_agents()
