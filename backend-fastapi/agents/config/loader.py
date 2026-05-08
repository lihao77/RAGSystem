# -*- coding: utf-8 -*-
"""
智能体动态加载器

支持从配置文件动态加载和创建智能体实例
"""

import logging
from typing import Dict, Optional, Type

from core.path_resolution import get_effective_workspace_root
from agents.core import BaseAgent
from agents.implementations import OrchestratorAgent
from .manager import get_config_manager
from tools.runtime.exposure import resolve_effective_tool_exposure
from tools.tool_registry import get_tool_registry

logger = logging.getLogger(__name__)


# 智能体类型注册表
AGENT_TYPES: Dict[str, Type[BaseAgent]] = {
    'orchestrator': OrchestratorAgent,
}


def register_agent_type(type_name: str, agent_class: Type[BaseAgent]):
    """
    注册新的智能体类型

    Args:
        type_name: 类型名称
        agent_class: 智能体类
    """
    AGENT_TYPES[type_name] = agent_class
    logger.debug(f"已注册智能体类型: {type_name} -> {agent_class.__name__}")


class AgentLoader:
    """
    智能体加载器

    负责从配置文件动态加载智能体实例
    """

    def __init__(self, model_adapter, system_config, orchestrator=None, config_manager=None, mcp_manager_getter=None, workspace_root=None):
        """
        初始化加载器

        Args:
            model_adapter: Model 适配器
            system_config: 系统配置
            orchestrator: 编排器（Orchestrator Agent 需要）
            workspace_root: 会话级工作区根路径（用于发现 workspace skills）
        """
        self.model_adapter = model_adapter
        self.system_config = system_config
        self.orchestrator = orchestrator
        self.config_manager = config_manager or get_config_manager()
        self._mcp_manager_getter = mcp_manager_getter
        self._tool_registry = get_tool_registry()
        self._workspace_root = workspace_root

    def _resolve_configs(self, configs=None):
        return configs if configs is not None else self.config_manager.get_all_configs()

    def invalidate_caches(self):
        """清除加载器依赖的所有缓存（Skills 等），使下次 load 重新扫描。"""
        from agents.skills.skill_loader import invalidate_skill_cache
        invalidate_skill_cache()

    def load_agent(
        self,
        agent_name: str,
        *,
        agent_config=None,
        ignore_enabled: bool = False,
    ) -> Optional[BaseAgent]:
        """
        加载单个智能体

        Args:
            agent_name: 智能体名称

        Returns:
            智能体实例，如果加载失败返回 None
        """
        try:
            # 获取智能体配置
            if agent_config is None:
                agent_config = self.config_manager.get_config(agent_name)
            if agent_config is None:
                logger.warning(f"智能体 '{agent_name}' 配置不存在")
                return None

            # 检查是否启用
            if not ignore_enabled and not agent_config.enabled:
                logger.debug(f"智能体 '{agent_name}' 已禁用")
                return None
            if ignore_enabled and not agent_config.enabled:
                logger.debug(f"智能体 '{agent_name}' 作为系统入口加载，忽略 enabled=false")

            # 确定智能体类型
            agent_type = self._get_agent_type(agent_name, agent_config)

            # 获取智能体类
            agent_class = AGENT_TYPES.get(agent_type)
            if agent_class is None:
                logger.error(f"未知的智能体类型: {agent_type}")
                return None

            if agent_type == 'orchestrator' and self.orchestrator is None:
                logger.warning("orchestrator 未提供，无法加载 Orchestrator Agent")
                return None

            # 创建智能体实例
            agent = self._create_agent_instance(
                agent_class,
                agent_name,
                agent_config
            )

            logger.debug(f"成功加载智能体: {agent_name} (类型: {agent_type})")
            return agent

        except Exception as e:
            logger.error(f"加载智能体 '{agent_name}' 失败: {e}", exc_info=True)
            return None

    def load_all_agents(self, configs=None) -> Dict[str, BaseAgent]:
        """
        加载所有启用的智能体

        Returns:
            智能体字典 {agent_name: agent_instance}
        """
        agents = {}
        all_configs = self._resolve_configs(configs)

        # 在 agent 加载前注入 workspace_root，确保 skill 解析可见
        if self._workspace_root:
            for agent_config in all_configs.values():
                custom_params = getattr(agent_config, 'custom_params', None)
                if isinstance(custom_params, dict):
                    custom_params.setdefault('workspace_root', self._workspace_root)

        # 1. 加载配置中的智能体
        for agent_name, agent_config in all_configs.items():
            agent = self.load_agent(
                agent_name,
                agent_config=agent_config,
                ignore_enabled=(agent_name == 'orchestrator_agent'),
            )
            if agent is not None:
                agents[agent_name] = agent

        # 2. 确保系统入口 Orchestrator Agent 存在
        if 'orchestrator_agent' not in agents:
            orchestrator_agent = self._load_system_orchestrator_agent()
            if orchestrator_agent is not None:
                agents['orchestrator_agent'] = orchestrator_agent
                logger.debug("✅ 已加载系统智能体: orchestrator_agent（默认配置兜底）")

        logger.info(f"成功加载 {len(agents)} 个智能体")
        return agents

    def resolve_default_entry_agent_name(self, configs=None) -> Optional[str]:
        """解析默认入口智能体名称。"""
        all_configs = self._resolve_configs(configs)
        explicit_defaults = []
        for agent_name, agent_config in all_configs.items():
            custom_params = getattr(agent_config, 'custom_params', {}) or {}
            if getattr(agent_config, 'default_entry', False) is True or custom_params.get('default_entry') is True:
                explicit_defaults.append(agent_name)

        if explicit_defaults:
            if len(explicit_defaults) > 1:
                logger.warning("检测到多个 default_entry=true，使用第一个: %s", explicit_defaults[0])
            return explicit_defaults[0]

        return None

    def _load_system_orchestrator_agent(self) -> Optional[BaseAgent]:
        """
        加载系统级 Orchestrator Agent

        如果当前 team 未配置 orchestrator_agent，则使用硬编码默认值兜底。

        Returns:
            Orchestrator Agent 实例
        """
        try:
            if self.orchestrator is None:
                logger.warning("orchestrator 未提供，无法加载 Orchestrator Agent")
                return None

            orchestrator_config = self._build_default_orchestrator_agent_config()
            orchestrator_agent = self.load_agent(
                'orchestrator_agent',
                agent_config=orchestrator_config,
                ignore_enabled=True,
            )

            return orchestrator_agent

        except ImportError as e:
            logger.error(f"Orchestrator Agent 模块未找到，请确认已正确安装: {e}")
            return None
        except Exception as e:
            logger.error(f"加载 Orchestrator Agent 失败: {e}", exc_info=True)
            return None

    def _build_default_orchestrator_agent_config(self):
        """构建 orchestrator_agent 的默认配置。"""
        from .models import AgentConfig, AgentLLMConfig, AgentTaskConfig

        logger.debug("Orchestrator Agent：当前 team 未配置，使用硬编码默认值")
        return AgentConfig(
            agent_name='orchestrator_agent',
            display_name='Orchestrator Agent',
            description='动态智能体编排器，将 Agent 当作工具使用，通过 ReAct 模式实时决策',
            enabled=True,
            default_entry=True,
            llm=AgentLLMConfig(
                provider=None,
                model_name=None,
                temperature=0.3,
                max_tokens=4096,
                timeout=60,
                retry_attempts=10,
                retry_backoff_factor=2.5,
            ),
            custom_params={
                'type': 'orchestrator',
                'behavior': {
                    'system_prompt': '你是一个智能体编排器，可以动态调用其他 Agent 完成复杂任务。',
                    'compression_trigger_ratio': 0.85,
                    'summarize_max_tokens': 300,
                    'preserve_recent_turns': 3,
                    'data_save_dir': None
                }
            },
            tasks=AgentTaskConfig(workflow=True, background=True),
            delegation={'enabled_agents': []},
        )

    def _get_agent_type(self, agent_name: str, agent_config) -> str:
        """
        确定智能体类型

        Args:
            agent_name: 智能体名称
            agent_config: 智能体配置

        Returns:
            智能体类型字符串
        """
        # 从 custom_params 中获取 type（兼容顶层和 behavior 嵌套两种写法）
        if hasattr(agent_config, 'custom_params') and agent_config.custom_params:
            cp = agent_config.custom_params
            # 优先：custom_params.type
            agent_type = cp.get('type')
            if agent_type:
                return agent_type
            # 兼容：custom_params.behavior.type
            behavior = cp.get('behavior')
            if isinstance(behavior, dict):
                agent_type = behavior.get('type')
                if agent_type:
                    return agent_type

        # 默认统一使用 orchestrator 类型
        logger.warning(f"智能体 '{agent_name}' 未指定 type，默认使用 'orchestrator'")
        return 'orchestrator'

    def _is_entry_agent(self, agent_config) -> bool:
        """判断 agent_config 是否为入口 Agent（用于 workspace skill 自动可见）。"""
        if getattr(agent_config, 'default_entry', False):
            return True
        custom_params = getattr(agent_config, 'custom_params', None) or {}
        if custom_params.get('default_entry'):
            return True
        # 从 orchestrator 或 loader 自身解析默认入口名称
        default_entry_name = None
        try:
            if self.orchestrator:
                default_entry_name = getattr(self.orchestrator, 'get_default_entry_agent_name', lambda: None)()
        except Exception:
            pass
        if not default_entry_name:
            try:
                default_entry_name = self.resolve_default_entry_agent_name()
            except Exception:
                pass
        return bool(default_entry_name and agent_config.agent_name == default_entry_name)

    @staticmethod
    def stamp_effective_skills(agent_config, skill_names: frozenset):
        """
        将 loader 解析后的有效 Skill 名称集合标记到 agent_config 上。

        exposure.py 的 get_tool_exposure_decision 会读取 _effective_skill_names
        来判断 skill 系统工具是否可见。该属性不持久化，仅作为 loader → runtime
        的运行时传递契约。
        """
        agent_config._effective_skill_names = skill_names

    def _resolve_available_skills(self, agent_config, exposure):
        from agents.skills.skill_loader import get_skill_loader

        custom_params = getattr(agent_config, 'custom_params', None) or {}
        workspace_root = custom_params.get('workspace_root')
        effective_workspace = get_effective_workspace_root(None, workspace_root) if workspace_root else None
        all_skills = get_skill_loader().load_all_skills(workspace_root=effective_workspace)
        enabled_skill_names = set(exposure['enabled_skill_names'])
        is_entry = self._is_entry_agent(agent_config)
        filtered_skills = []
        for skill in all_skills:
            if skill.source_type == 'workspace':
                if is_entry or skill.name in enabled_skill_names:
                    filtered_skills.append(skill)
                continue
            if skill.name in enabled_skill_names:
                filtered_skills.append(skill)
        inject_skill_tools = bool(filtered_skills and getattr(getattr(agent_config, 'skills', None), 'auto_inject', True))
        return filtered_skills, inject_skill_tools

    def _resolve_tools_and_skills(self, agent_config):
        """
        根据 agent_config 过滤工具列表并注入 Skills/MCP/delegation 工具

        Returns:
            (available_tools, available_skills) 元组
        """
        exposure = resolve_effective_tool_exposure(agent_config)
        decisions = exposure['decisions']
        filtered_tools = []

        direct_tools = self._tool_registry.get_direct_tools()
        direct_tool_names = set(exposure['direct_tool_names'])
        if direct_tool_names:
            filtered_tools.extend([
                tool for tool in direct_tools
                if tool.get('function', {}).get('name') in direct_tool_names
            ])
            logger.debug(f"{agent_config.agent_name} 启用 direct 工具: {sorted(direct_tool_names)}")
        else:
            logger.debug(f"{agent_config.agent_name} 未配置 direct 工具")

        memory_tool_names = set(exposure.get('memory_tool_names', []))
        if memory_tool_names:
            existing_tool_names = {t.get('function', {}).get('name') for t in filtered_tools}
            for memory_tool in direct_tools:
                tool_name = memory_tool.get('function', {}).get('name')
                if tool_name and tool_name in memory_tool_names and tool_name not in existing_tool_names:
                    filtered_tools.append(memory_tool)
                    existing_tool_names.add(tool_name)
            logger.debug(f"{agent_config.agent_name} 启用 memory 工具: {sorted(memory_tool_names)}")

        task_tool_names = set(exposure.get('task_tool_names', []))
        if task_tool_names:
            existing_tool_names = {t.get('function', {}).get('name') for t in filtered_tools}
            for task_tool in self._tool_registry.get_task_tools():
                tool_name = task_tool.get('function', {}).get('name')
                if tool_name and tool_name in task_tool_names and tool_name not in existing_tool_names:
                    filtered_tools.append(task_tool)
            logger.debug(f"{agent_config.agent_name} 启用 task 工具: {sorted(task_tool_names)}")

        filtered_skills, inject_skill_tools = self._resolve_available_skills(agent_config, exposure)
        self.stamp_effective_skills(agent_config, frozenset(s.name for s in filtered_skills))
        if filtered_skills:
            logger.debug(
                "%s 启用 Skills: %s",
                agent_config.agent_name,
                [f"{skill.name}({skill.source_type})" for skill in filtered_skills],
            )
            if inject_skill_tools:
                existing_tool_names = {t.get('function', {}).get('name') for t in filtered_tools}
                for skill_tool in self._tool_registry.get_skill_tools():
                    tool_name = skill_tool.get('function', {}).get('name')
                    if tool_name and tool_name not in existing_tool_names:
                        filtered_tools.append(skill_tool)
        else:
            logger.debug(f"{agent_config.agent_name} 未配置 Skills")

        mcp_config = getattr(agent_config, 'mcp', None)
        if mcp_config and getattr(mcp_config, 'enabled_servers', None):
            try:
                manager_getter = self._mcp_manager_getter
                if manager_getter is None:
                    from mcp import get_mcp_manager
                    manager_getter = get_mcp_manager
                manager = manager_getter()
                for server_name in mcp_config.enabled_servers:
                    mcp_tools = manager.get_tools_openai_format(server_name)
                    if mcp_tools:
                        filtered_tools.extend(mcp_tools)
                        logger.debug(
                            f"  → {agent_config.agent_name} 注入 MCP 工具 ({server_name}): {len(mcp_tools)} 个"
                        )
                    else:
                        logger.warning(
                            f"  ⚠ MCP Server '{server_name}' 未连接或无工具，智能体 {agent_config.agent_name} 的该 Server 工具跳过"
                        )
            except Exception as e:
                logger.warning(f"注入 MCP 工具失败（{agent_config.agent_name}）: {e}")

        enabled_agents = getattr(getattr(agent_config, 'delegation', None), 'enabled_agents', []) or []
        if enabled_agents:
            existing_tool_names = {t.get('function', {}).get('name') for t in filtered_tools}
            for agent_tool in self._tool_registry.get_agent_tools():
                tool_name = agent_tool.get('function', {}).get('name')
                if tool_name and decisions.get(tool_name) and tool_name not in existing_tool_names:
                    filtered_tools.append(agent_tool)
            logger.debug(f"{agent_config.agent_name} 启用 delegation: {enabled_agents}")

        builtin_tool_names = {t.get('function', {}).get('name') for t in filtered_tools}
        request_user_input_tool = self._tool_registry.get_tool_by_name('request_user_input')
        if request_user_input_tool and 'request_user_input' not in builtin_tool_names:
            filtered_tools.append(request_user_input_tool)

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
        filtered_tools, filtered_skills = self._resolve_tools_and_skills(agent_config)

        if agent_class == OrchestratorAgent:
            common_kwargs.update({
                'agent_name': agent_config.agent_name,
                'display_name': agent_config.display_name,
                'description': agent_config.description,
                'orchestrator': self.orchestrator,
                'available_tools': filtered_tools,
                'available_skills': filtered_skills,
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
