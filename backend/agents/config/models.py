# -*- coding: utf-8 -*-
"""
智能体配置模型

支持为每个智能体配置独立的 LLM、工具和其他参数
"""

from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field, ConfigDict
from enum import Enum


class AgentLLMConfig(BaseModel):
    """
    智能体的 LLM 配置

    可以为每个智能体指定不同的 LLM Provider 和模型。
    调用 ModelAdapter 时传 provider + provider_type + model_name，由后端解析为复合键。
    """
    provider: Optional[str] = Field(
        default=None,
        description="Provider 名称（如 'test', 'openai'），None 表示使用系统默认"
    )
    provider_type: Optional[str] = Field(
        default=None,
        description="Provider 类型（如 'deepseek', 'openrouter'），与 provider 一起用于解析复合键"
    )
    model_name: Optional[str] = Field(
        default=None,
        description="模型名称（如 'deepseek-chat', 'gpt-4'），None 表示使用系统默认"
    )
    temperature: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=2.0,
        description="生成温度，None 表示使用系统默认"
    )
    max_tokens: Optional[int] = Field(
        default=None,
        ge=1,
        description="（已废弃，请使用 max_completion_tokens）最大生成 token 数，None 表示使用系统默认"
    )
    max_completion_tokens: Optional[int] = Field(
        default=None,
        ge=1,
        description="单次输出的最大 token 数（如 4096），None 表示使用系统默认。优先级高于 max_tokens"
    )
    max_context_tokens: Optional[int] = Field(
        default=None,
        ge=1,
        description="模型支持的最大上下文窗口（如 128000），None 表示自动推断或使用系统默认"
    )
    top_p: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Top-p 采样参数"
    )
    timeout: Optional[int] = Field(
        default=None,
        ge=1,
        le=300,
        description="超时时间（秒），None 表示使用系统默认"
    )
    retry_attempts: Optional[int] = Field(
        default=None,
        ge=0,
        le=10,
        description="重试次数，None 表示使用系统默认"
    )

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典，过滤 None 值"""
        return {k: v for k, v in self.model_dump().items() if v is not None}

    def merge_with_default(self, default_config, model_adapter=None) -> Dict[str, Any]:
        """
        与默认配置合并，支持从 ModelAdapter 获取 Provider 元数据

        Args:
            default_config: 系统默认配置对象（可以为 None）
            model_adapter: ModelAdapter 实例（可选，用于获取 Provider 配置）

        Returns:
            合并后的配置字典
        """
        result = {}

        # 使用智能体配置优先，否则使用系统默认
        default_llm = getattr(default_config, 'llm', None) if default_config else None
        result['provider'] = self.provider or getattr(default_llm, 'provider', None)
        result['provider_type'] = self.provider_type or getattr(default_llm, 'provider_type', None)
        result['model_name'] = self.model_name or getattr(default_llm, 'model_name', None)
        result['temperature'] = self.temperature if self.temperature is not None else getattr(default_llm, 'temperature', 0.7)

        # 输出 token 限制：优先级 Agent配置 > ModelAdapter Provider配置 > 系统默认
        completion_tokens = self.max_completion_tokens or self.max_tokens
        if not completion_tokens and model_adapter and result['provider'] and result['provider_type']:
            # 尝试从 ModelAdapter 获取 Provider 配置
            try:
                provider_key = f"{result['provider']}_{result['provider_type']}"
                provider = model_adapter.providers.get(provider_key)
                if provider and hasattr(provider, 'max_completion_tokens'):
                    completion_tokens = provider.max_completion_tokens
            except Exception:
                pass  # 静默失败，使用默认值

        result['max_tokens'] = completion_tokens or getattr(default_llm, 'max_tokens', 4096)

        # 上下文窗口：优先级 Agent配置 > ModelAdapter Provider配置 > 系统默认
        context_tokens = self.max_context_tokens
        if not context_tokens and model_adapter and result['provider'] and result['provider_type']:
            # 尝试从 ModelAdapter 获取 Provider 配置
            try:
                provider_key = f"{result['provider']}_{result['provider_type']}"
                provider = model_adapter.providers.get(provider_key)
                if provider and hasattr(provider, 'max_context_tokens'):
                    context_tokens = provider.max_context_tokens
            except Exception:
                pass  # 静默失败，使用默认值

        result['max_context_tokens'] = context_tokens or getattr(default_llm, 'max_context_tokens', None)

        result['timeout'] = self.timeout or getattr(default_llm, 'timeout', 30)
        result['retry_attempts'] = self.retry_attempts if self.retry_attempts is not None else getattr(default_llm, 'retry_attempts', 3)

        if self.top_p is not None:
            result['top_p'] = self.top_p

        return result


class AgentToolConfig(BaseModel):
    """
    智能体的工具配置

    定义智能体可以使用哪些工具
    """
    enabled_tools: List[str] = Field(
        default_factory=list,
        description="启用的工具名称列表。空列表表示不启用任何工具"
    )


class AgentSkillConfig(BaseModel):
    """
    智能体的 Skills 配置

    定义智能体可以访问哪些 Skills
    """
    enabled_skills: List[str] = Field(
        default_factory=list,
        description="启用的 Skill 名称列表，留空表示不启用任何 Skill"
    )
    auto_inject: bool = Field(
        default=True,
        description="是否自动检测并注入匹配的 Skill（True）还是只在 system prompt 中列出（False）"
    )


class AgentConfig(BaseModel):
    """
    智能体完整配置

    包含 LLM 配置、工具配置和其他智能体特定参数
    """
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "agent_name": "custom_agent",
                "display_name": "自定义智能体",
                "description": "通过配置定义的智能体",
                "enabled": True,
                "llm": {
                    "provider": "deepseek",
                    "model_name": "deepseek-chat",
                    "temperature": 0.3,
                    "max_completion_tokens": 4096,
                    "max_context_tokens": 128000
                },
                "tools": {
                    "enabled_tools": ["query_kg", "semantic_search"]
                },
                "skills": {
                    "enabled_skills": ["disaster-report-example"],
                    "auto_inject": True
                },
                "custom_params": {
                    "type": "react",
                    "behavior": {
                        "system_prompt": "你是一个专门做XX的智能体...",
                        "max_rounds": 10,
                        "auto_execute_tools": True,
                        "task_patterns": ["查询.*", "分析.*"]
                    }
                }
            }
        }
    )

    agent_name: str = Field(
        ...,
        description="智能体名称（唯一标识）"
    )

    display_name: Optional[str] = Field(
        default=None,
        description="显示名称"
    )

    description: Optional[str] = Field(
        default=None,
        description="智能体描述"
    )

    enabled: bool = Field(
        default=True,
        description="是否启用该智能体"
    )

    llm: AgentLLMConfig = Field(
        default_factory=AgentLLMConfig,
        description="默认 LLM 配置（用于主任务）"
    )

    llm_tiers: Optional[Dict[str, AgentLLMConfig]] = Field(
        default=None,
        description="多层级 LLM 配置（可选）。支持 fast/default/powerful 三个层级，用于不同复杂度的任务"
    )

    tools: AgentToolConfig = Field(
        default_factory=AgentToolConfig,
        description="工具配置"
    )

    skills: AgentSkillConfig = Field(
        default_factory=AgentSkillConfig,
        description="Skills 配置"
    )

    custom_params: Dict[str, Any] = Field(
        default_factory=dict,
        description="智能体特定的自定义参数"
    )


class AgentConfigPreset(str, Enum):
    """
    预设配置模板

    提供常用的配置模板供快速使用
    """
    FAST = "fast"           # 快速响应（小模型、低温度）
    BALANCED = "balanced"   # 平衡模式（中等模型、中等温度）
    ACCURATE = "accurate"   # 精确模式（大模型、低温度）
    CREATIVE = "creative"   # 创意模式（大模型、高温度）
    CHEAP = "cheap"         # 经济模式（便宜模型）


# 预设配置定义
PRESET_CONFIGS = {
    AgentConfigPreset.FAST: {
        "llm": {
            "temperature": 0.1,
            "max_completion_tokens": 2048
        }
    },
    AgentConfigPreset.BALANCED: {
        "llm": {
            "temperature": 0.5,
            "max_completion_tokens": 4096
        }
    },
    AgentConfigPreset.ACCURATE: {
        "llm": {
            "temperature": 0.1,
            "max_completion_tokens": 8192
        }
    },
    AgentConfigPreset.CREATIVE: {
        "llm": {
            "temperature": 0.9,
            "max_completion_tokens": 4096
        }
    },
    AgentConfigPreset.CHEAP: {
        "llm": {
            "temperature": 0.5,
            "max_completion_tokens": 2048
        }
    }
}


def apply_preset(config: AgentConfig, preset: AgentConfigPreset) -> AgentConfig:
    """
    应用预设配置到智能体配置

    Args:
        config: 智能体配置
        preset: 预设模板

    Returns:
        应用预设后的配置
    """
    preset_data = PRESET_CONFIGS.get(preset, {})

    # 更新 LLM 配置
    if 'llm' in preset_data:
        for key, value in preset_data['llm'].items():
            setattr(config.llm, key, value)

    return config
