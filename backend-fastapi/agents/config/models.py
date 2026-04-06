# -*- coding: utf-8 -*-
"""
智能体配置模型

支持为每个智能体配置独立的 LLM、工具和其他参数
"""

from typing import Optional, Dict, Any, List
from enum import Enum

try:
    from pydantic import BaseModel, Field, ConfigDict, model_validator
    _PYDANTIC_V2 = True
except ImportError:
    from pydantic import BaseModel, Field, root_validator
    ConfigDict = dict
    model_validator = None
    _PYDANTIC_V2 = False

_ALLOWED_LLM_TIERS = {'fast', 'default', 'powerful'}


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
    max_completion_tokens: Optional[int] = Field(
        default=None,
        ge=1,
        description="单次输出的最大 token 数（如 4096），None 表示使用系统默认"
    )
    max_context_tokens: Optional[int] = Field(
        default=None,
        ge=1,
        description="模型支持的最大上下文窗口（如 128000），None 表示自动推断或使用系统默认"
    )
    extra_params: Dict[str, Any] = Field(
        default_factory=dict,
        description="额外的 provider-specific payload 字段，将透传给模型调用"
    )

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典，过滤 None 值"""
        return {
            k: v for k, v in self.model_dump().items()
            if v is not None and (k != 'extra_params' or v)
        }

    def merge_with_default(self, default_config, model_adapter=None) -> Dict[str, Any]:
        """
        与默认配置合并，支持从 ModelAdapter 获取 Provider 元数据

        Args:
            default_config: 系统默认配置对象（可以为 None）
            model_adapter: ModelAdapter 实例（可选，用于获取 Provider 配置）

        Returns:
            合并后的配置字典
        """
        del model_adapter
        result = {}

        default_llm = getattr(default_config, 'llm', None) if default_config else None
        result['provider'] = self.provider or getattr(default_llm, 'provider', None)
        result['provider_type'] = self.provider_type or getattr(default_llm, 'provider_type', None)
        result['model_name'] = self.model_name or getattr(default_llm, 'model_name', None)
        result['temperature'] = self.temperature if self.temperature is not None else getattr(default_llm, 'temperature', 0.7)
        result['max_completion_tokens'] = (
            self.max_completion_tokens
            if self.max_completion_tokens is not None
            else getattr(default_llm, 'max_completion_tokens', 4096)
        )
        result['max_context_tokens'] = self.max_context_tokens or getattr(default_llm, 'max_context_tokens', None)

        reserved_keys = {
            'provider',
            'provider_type',
            'model_name',
            'temperature',
            'max_completion_tokens',
            'max_context_tokens',
        }
        merged_extra_params = dict(getattr(default_llm, 'extra_params', None) or {})
        merged_extra_params.update(self.extra_params or {})
        for key, value in merged_extra_params.items():
            if key in reserved_keys:
                continue
            result[key] = value

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


class AgentMCPConfig(BaseModel):
    """
    智能体的 MCP Server 配置

    定义智能体可以使用哪些 MCP Server 的工具
    """
    enabled_servers: List[str] = Field(
        default_factory=list,
        description="启用的 MCP Server 名称列表，留空表示不使用 MCP 工具"
    )


class AgentMemoryConfig(BaseModel):
    """智能体的 memory 配置。"""

    auto_inject: bool = Field(
        default=True,
        description="是否在构建上下文时自动注入 MEMORY.md 索引头部"
    )
    allowed_scopes: List[str] = Field(
        default_factory=lambda: ['team', 'session'],
        description="允许访问的 memory scope 列表"
    )
    write_scopes: List[str] = Field(
        default_factory=lambda: ['session'],
        description="允许写入的 memory scope 列表"
    )
    archive_scopes: List[str] = Field(
        default_factory=lambda: ['session'],
        description="允许归档的 memory scope 列表"
    )

    if _PYDANTIC_V2:
        @model_validator(mode='after')
        def validate_scope_relationships(self):
            allowed_scopes = set(self.allowed_scopes or [])
            write_scopes = set(self.write_scopes or [])
            archive_scopes = set(self.archive_scopes or [])

            invalid_write_scopes = sorted(write_scopes - allowed_scopes)
            if invalid_write_scopes:
                raise ValueError(f"write_scopes 必须是 allowed_scopes 的子集: {invalid_write_scopes}")

            invalid_archive_scopes = sorted(archive_scopes - allowed_scopes)
            if invalid_archive_scopes:
                raise ValueError(f"archive_scopes 必须是 allowed_scopes 的子集: {invalid_archive_scopes}")

            return self
    else:
        @root_validator(pre=False, allow_reuse=True)
        def validate_scope_relationships(cls, values):
            allowed_scopes = set(values.get('allowed_scopes') or [])
            write_scopes = set(values.get('write_scopes') or [])
            archive_scopes = set(values.get('archive_scopes') or [])

            invalid_write_scopes = sorted(write_scopes - allowed_scopes)
            if invalid_write_scopes:
                raise ValueError(f"write_scopes 必须是 allowed_scopes 的子集: {invalid_write_scopes}")

            invalid_archive_scopes = sorted(archive_scopes - allowed_scopes)
            if invalid_archive_scopes:
                raise ValueError(f"archive_scopes 必须是 allowed_scopes 的子集: {invalid_archive_scopes}")

            return values


class AgentDelegationConfig(BaseModel):
    """智能体的 delegation 配置。"""

    enabled_agents: List[str] = Field(
        default_factory=list,
        description="允许当前 Agent 委派调用的子 Agent 名称列表，留空表示禁用 delegation",
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
                "default_entry": False,
                "llm_tiers": {
                    "default": {
                        "provider": "deepseek",
                        "model_name": "deepseek-chat",
                        "temperature": 0.3,
                        "max_completion_tokens": 4096,
                        "max_context_tokens": 128000,
                    },
                    "fast": {
                        "provider": "deepseek",
                        "model_name": "deepseek-chat",
                        "temperature": 0.2,
                        "max_completion_tokens": 1000,
                    }
                },
                "tools": {
                    "enabled_tools": ["query_kg", "semantic_search"]
                },
                "skills": {
                    "enabled_skills": ["disaster-report-example"],
                    "auto_inject": True
                },
                "custom_params": {
                    "type": "orchestrator",
                    "behavior": {
                        "system_prompt": "你是一个专门做XX的智能体...",
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

    default_entry: bool = Field(
        default=False,
        description="是否作为默认入口智能体。显式指定的 preferred_agent 优先级更高"
    )

    llm_tiers: Optional[Dict[str, AgentLLMConfig]] = Field(
        default=None,
        description="多层级 LLM 配置。支持 fast/default/powerful 三个层级，用于不同复杂度的任务。default 为必配主层级"
    )

    tools: AgentToolConfig = Field(
        default_factory=AgentToolConfig,
        description="工具配置"
    )

    skills: AgentSkillConfig = Field(
        default_factory=AgentSkillConfig,
        description="Skills 配置"
    )

    mcp: AgentMCPConfig = Field(
        default_factory=AgentMCPConfig,
        description="MCP Server 配置"
    )

    memory: AgentMemoryConfig = Field(
        default_factory=AgentMemoryConfig,
        description="memory 配置"
    )

    delegation: AgentDelegationConfig = Field(
        default_factory=AgentDelegationConfig,
        description="子 Agent 委派配置"
    )

    custom_params: Dict[str, Any] = Field(
        default_factory=dict,
        description="智能体特定的自定义参数"
    )

    if _PYDANTIC_V2:
        @model_validator(mode='after')
        def validate_llm_tier_keys(self):
            llm_tiers = self.llm_tiers or {}
            invalid_keys = sorted(set(llm_tiers.keys()) - _ALLOWED_LLM_TIERS)
            if invalid_keys:
                raise ValueError(f"llm_tiers 仅支持 fast/default/powerful: {invalid_keys}")
            return self
    else:
        @root_validator(pre=False, allow_reuse=True)
        def validate_llm_tier_keys(cls, values):
            llm_tiers = values.get('llm_tiers') or {}
            invalid_keys = sorted(set(llm_tiers.keys()) - _ALLOWED_LLM_TIERS)
            if invalid_keys:
                raise ValueError(f"llm_tiers 仅支持 fast/default/powerful: {invalid_keys}")
            return values


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


# 预设配置定义（应用到 llm_tiers.default）
PRESET_CONFIGS = {
    AgentConfigPreset.FAST: {
        "temperature": 0.1,
        "max_completion_tokens": 2048
    },
    AgentConfigPreset.BALANCED: {
        "temperature": 0.5,
        "max_completion_tokens": 4096
    },
    AgentConfigPreset.ACCURATE: {
        "temperature": 0.1,
        "max_completion_tokens": 8192
    },
    AgentConfigPreset.CREATIVE: {
        "temperature": 0.9,
        "max_completion_tokens": 4096
    },
    AgentConfigPreset.CHEAP: {
        "temperature": 0.5,
        "max_completion_tokens": 2048
    }
}


def apply_preset(config: AgentConfig, preset: AgentConfigPreset) -> AgentConfig:
    """
    应用预设配置到智能体配置的 llm_tiers.default

    Args:
        config: 智能体配置
        preset: 预设模板

    Returns:
        应用预设后的配置
    """
    preset_data = PRESET_CONFIGS.get(preset, {})

    if preset_data:
        tiers = config.llm_tiers or {}
        default_tier = tiers.get('default') or AgentLLMConfig()
        for key, value in preset_data.items():
            setattr(default_tier, key, value)
        tiers['default'] = default_tier
        config.llm_tiers = tiers

    return config
