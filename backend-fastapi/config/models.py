# -*- coding: utf-8 -*-
"""
配置数据模型 - 使用 Pydantic 提供类型安全和验证
"""

from pydantic import BaseModel, Field, ConfigDict, field_validator
from typing import Dict, Optional, Literal


class LLMConfig(BaseModel):
    """LLM 配置 - 支持 ModelAdapter"""
    model_config = ConfigDict(extra='allow')

    provider: str = Field(default="", description="AI 提供商名称（openai/deepseek/openrouter）")
    provider_type: str = Field(default="", description="Provider 类型（用于精确查找，避免同名冲突）")
    model_name: str = Field(default="deepseek-chat", description="默认 Chat 模型名称")

    # 统一模型映射 (Task -> Model ID)
    model_map: Dict[str, str] = Field(default_factory=dict, description="任务到模型 ID 的映射")

    temperature: float = Field(default=0.7, ge=0.0, le=2.0, description="生成温度，控制输出随机性")
    max_completion_tokens: int = Field(default=4096, ge=1, description="单次输出的最大 token 数")
    max_context_tokens: Optional[int] = Field(default=None, ge=1, description="模型支持的最大上下文窗口")
    thinking_budget_tokens: Optional[int] = Field(default=None, ge=1, description="思考预算 token 数（仅部分模型支持）")
    reasoning_effort: Optional[Literal['low', 'medium', 'high']] = Field(default=None, description="推理强度（仅部分模型支持）")
    timeout: int = Field(default=30, ge=1, description="单次请求超时时间（秒）")
    retry_attempts: int = Field(default=10, ge=0, description="失败重试次数")
    retry_backoff_factor: float = Field(default=2.5, ge=1.0, description="重试退避因子")

    @field_validator('reasoning_effort', mode='before')
    @classmethod
    def _blank_reasoning_effort_to_none(cls, value):
        if value == "":
            return None
        return value


class SystemConfig(BaseModel):
    """系统配置"""
    model_config = ConfigDict(extra='allow')

    max_content_length: int = Field(default=100 * 1024 * 1024, ge=1, description="最大内容长度（字节），默认 100MB")


class EmbeddingConfig(BaseModel):
    """Embedding 配置 - 仅支持 ModelAdapter"""
    model_config = ConfigDict(extra='allow')

    provider: str = Field(default="", description="Embedding 提供商名称（留空表示未配置）")
    provider_type: str = Field(default="", description="Provider 类型（用于精确查找，避免同名冲突）")
    model_name: str = Field(default="", description="Embedding 模型名称")
    batch_size: int = Field(default=100, ge=1, description="批处理大小")

class SQLiteVectorConfig(BaseModel):
    """SQLite + sqlite-vec 向量存储配置"""
    model_config = ConfigDict(extra='allow')

    database_path: str = Field(default="", description="数据库路径（留空使用默认，相对路径解析到 DB_ROOT）")
    vector_dimension: int = Field(default=0, ge=0, description="向量维度（0=自动匹配 Embedding 模型）")
    distance_metric: Literal['cosine', 'l2', 'ip'] = Field(default="cosine", description="距离度量")


class VectorStoreConfig(BaseModel):
    """向量存储配置"""
    model_config = ConfigDict(extra='ignore')

    backend: Literal['sqlite_vec'] = Field(
        default="sqlite_vec",
        description="向量存储后端类型",
        json_schema_extra={"ui_exclude": True},
    )
    sqlite_vec: SQLiteVectorConfig = Field(default_factory=SQLiteVectorConfig, description="SQLite 向量存储配置")


class HooksWorkspaceTrustRuleConfig(BaseModel):
    """Hook 工作区信任规则"""
    model_config = ConfigDict(extra='allow')

    workspace_root_prefix: str = ""
    trust: Literal['trusted', 'untrusted'] = 'trusted'


class HooksWorkspaceTrustConfig(BaseModel):
    """Hook 工作区信任配置"""
    model_config = ConfigDict(extra='allow')

    default: Literal['trusted', 'untrusted'] = 'trusted'
    rules: list[HooksWorkspaceTrustRuleConfig] = Field(default_factory=list)


class HooksConfig(BaseModel):
    """Hook 系统配置"""
    model_config = ConfigDict(extra='allow')

    enabled: bool = Field(default=True, description="是否启用 Hook 系统")
    workspace_trust: HooksWorkspaceTrustConfig = Field(default_factory=HooksWorkspaceTrustConfig, description="工作区信任配置")


class WaitingConfig(BaseModel):
    """后台任务等待与 KV cache 保活配置"""
    model_config = ConfigDict(extra='allow')

    enabled: bool = Field(default=True, description="是否启用后台等待机制")
    default_poll_interval_seconds: float = Field(default=3.0, ge=0.5, description="默认轮询间隔（秒）")
    max_poll_interval_seconds: float = Field(default=15.0, ge=1.0, description="最大轮询间隔（秒）")
    idle_wait_timeout_seconds: float = Field(default=300.0, ge=10.0, description="空闲等待超时（秒）")
    local_cache_ttl_seconds: float = Field(default=600.0, ge=60.0, description="本地缓存 TTL（秒）")
    keepalive_interval_seconds: float = Field(default=240.0, ge=30.0, description="KV cache 保活间隔（秒）")
    keepalive_grace_seconds: float = Field(default=30.0, ge=5.0, description="保活宽限期（秒）")
    max_keepalive_rounds: int = Field(default=20, ge=1, description="最大保活轮数")
    allow_provider_keepalive: bool = Field(default=True, description="是否允许 Provider 级别保活")
    hidden_keepalive_token_budget: int = Field(default=8, ge=1, description="隐藏保活 token 预算")


class MemoryConfig(BaseModel):
    """记忆系统配置"""
    model_config = ConfigDict(extra='allow')

    index_max_lines: int = Field(default=200, ge=10, description="记忆索引注入最大行数")
    index_max_chars: int = Field(default=25600, ge=1024, description="记忆索引注入最大字符数")
    search_limit: int = Field(default=5, ge=1, le=50, description="记忆召回返回条目数上限")


class ToolsConfig(BaseModel):
    """工具执行配置"""
    model_config = ConfigDict(extra='allow')

    bash_default_timeout: int = Field(default=120, ge=10, description="Bash 工具默认超时（秒）")
    bash_max_timeout: int = Field(default=600, ge=60, description="Bash 工具最大超时（秒）")
    bash_max_output: int = Field(default=50000, ge=1000, description="Bash 工具最大输出（字节）")
    code_default_timeout: int = Field(default=60, ge=10, description="代码沙箱默认超时（秒）")
    code_max_timeout: int = Field(default=300, ge=60, description="代码沙箱最大超时（秒）")


class ContextConfig(BaseModel):
    """上下文预算配置"""
    model_config = ConfigDict(extra='allow')

    compression_trigger_ratio: float = Field(default=0.85, ge=0.5, le=0.99, description="触发上下文压缩的 token 使用比例")
    summarize_max_tokens: int = Field(default=300, ge=50, description="LLM 摘要的最大 token 数")
    preserve_recent_turns: int = Field(default=3, ge=1, le=20, description="压缩时保留的最近对话轮数")
    system_prompt_reserve: int = Field(default=2000, ge=500, description="系统提示词预留 token 数")
    min_context_budget: int = Field(default=4000, ge=1000, description="最小上下文预算 token 数")


class ReflectionConfig(BaseModel):
    """反思机制配置（系统级默认，agent 级可覆盖）"""
    model_config = ConfigDict(extra='allow')

    enabled: bool = Field(default=True, description="是否启用反思机制")
    consecutive_tool_failures: int = Field(default=2, ge=1, description="连续工具失败 N 次触发反思")
    repeated_tool_calls: int = Field(default=3, ge=2, description="同一工具连续调用 N 次触发")
    rounds_without_answer: int = Field(default=6, ge=2, description="N 轮无答案时触发")
    empty_result_count: int = Field(default=2, ge=1, description="空结果累积 N 次触发")
    max_reflections_per_run: int = Field(default=3, ge=1, description="单次 run 最大反思次数")


class AppConfig(BaseModel):
    """主配置模型"""
    model_config = ConfigDict(
        extra='allow',
        env_nested_delimiter='__',
        case_sensitive=False
    )

    vector_store: VectorStoreConfig = Field(default_factory=VectorStoreConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    system: SystemConfig = Field(default_factory=SystemConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    hooks: HooksConfig = Field(default_factory=HooksConfig)
    waiting: WaitingConfig = Field(default_factory=WaitingConfig)
    reflection: ReflectionConfig = Field(default_factory=ReflectionConfig)
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
    tools: ToolsConfig = Field(default_factory=ToolsConfig)
    context: ContextConfig = Field(default_factory=ContextConfig)
