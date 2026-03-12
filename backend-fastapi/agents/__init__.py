# -*- coding: utf-8 -*-
"""
Agent 模块 - 智能体系统

重组后的模块结构：
- core: 核心基础设施（BaseAgent, AgentContext, Registry, Orchestrator）
- implementations: 智能体实现（ReActAgent, OrchestratorAgent）
- config: 配置系统（AgentConfig, AgentConfigManager, AgentLoader）
- context: 上下文管理（ContextPipeline）
- events: 事件系统（EventBus, EventPublisher, SSEAdapter）
- skills: Skills 系统
"""

# 核心基础设施（立即导入，无重依赖）
from .core import (
    BaseAgent,
    AgentContext,
    AgentResponse,
    Message,
    AgentExecutionError,
    AgentRegistry,
    get_registry,
    register_agent,
    AgentOrchestrator,
    get_orchestrator,
)

# 配置与实现按需导入，避免在仅使用 core 时拉取 tools/db 等
_CONFIG_ATTRS = {
    'AgentConfig', 'AgentLLMConfig', 'AgentToolConfig', 'AgentConfigPreset',
    'apply_preset', 'AgentConfigManager', 'get_config_manager',
    'AgentLoader', 'load_agents_from_config', 'register_agent_type',
    'AgentSkillConfig', 'PRESET_CONFIGS',
}
_IMPL_ATTRS = {'ReActAgent', 'OrchestratorAgent'}


def __getattr__(name):
    if name in _CONFIG_ATTRS:
        from . import config
        return getattr(config, name)
    if name in _IMPL_ATTRS:
        if name == 'ReActAgent':
            from .implementations.react import ReActAgent
            return ReActAgent
        from .implementations.orchestrator import OrchestratorAgent
        return OrchestratorAgent
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    # 基础设施
    'BaseAgent',
    'AgentContext',
    'AgentResponse',
    'Message',
    'AgentExecutionError',
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
    'AgentLoader',
    'load_agents_from_config',
    'register_agent_type',
    # 智能体实现
    'ReActAgent',
    'OrchestratorAgent',
]
