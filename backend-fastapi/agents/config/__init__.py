# -*- coding: utf-8 -*-
"""
Config - 智能体配置系统
"""

from .models import (
    AgentConfig,
    AgentLLMConfig,
    AgentToolConfig,
    AgentSkillConfig,
    AgentMCPConfig,
    AgentConfigPreset,
    PRESET_CONFIGS,
    apply_preset,
)
from .manager import AgentConfigManager, get_config_manager
from .loader import AgentLoader, load_agents_from_config, register_agent_type, AGENT_TYPES

__all__ = [
    'AgentConfig',
    'AgentLLMConfig',
    'AgentToolConfig',
    'AgentSkillConfig',
    'AgentMCPConfig',
    'AgentConfigPreset',
    'PRESET_CONFIGS',
    'apply_preset',
    'AgentConfigManager',
    'get_config_manager',
    'AgentLoader',
    'load_agents_from_config',
    'register_agent_type',
    'AGENT_TYPES',
]
