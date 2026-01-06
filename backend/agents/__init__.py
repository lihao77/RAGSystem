# -*- coding: utf-8 -*-
"""
Agent 模块 - 智能体系统

包含：
- 基础设施：BaseAgent, AgentContext, AgentResponse
- 注册表：AgentRegistry
- 编排器：AgentOrchestrator
- 配置系统：AgentConfig, AgentConfigManager
- 具体智能体：MasterAgent, GenericAgent, ReActAgent
"""

# 基础设施
from .base import (
    BaseAgent,
    AgentContext,
    AgentResponse,
    Message,
    AgentExecutionError
)

# 注册表和编排器
from .registry import AgentRegistry, get_registry, register_agent
from .orchestrator import AgentOrchestrator, get_orchestrator

# 配置系统
from .agent_config import (
    AgentConfig,
    AgentLLMConfig,
    AgentToolConfig,
    AgentConfigPreset,
    apply_preset
)
from .config_manager import AgentConfigManager, get_config_manager

# 具体智能体
from .master_agent import MasterAgent
from .generic_agent import GenericAgent
from .react_agent import ReActAgent

# 动态加载
from .agent_loader import AgentLoader, load_agents_from_config, register_agent_type

__all__ = [
    # 基础设施
    'BaseAgent',
    'AgentContext',
    'AgentResponse',
    'Message',
    'AgentExecutionError',

    # 注册表和编排器
    'AgentRegistry',
    'get_registry',
    'register_agent',
    'AgentOrchestrator',
    'get_orchestrator',

    # 配置系统
    'AgentConfig',
    'AgentLLMConfig',
    'AgentToolConfig',
    'AgentConfigPreset',
    'apply_preset',
    'AgentConfigManager',
    'get_config_manager',

    # 具体智能体
    'MasterAgent',
    'GenericAgent',
    'ReActAgent',

    # 动态加载
    'AgentLoader',
    'load_agents_from_config',
    'register_agent_type',
]
