# -*- coding: utf-8 -*-
"""
配置数据模型 - 使用 Pydantic 提供类型安全和验证
"""

from pydantic import BaseModel, Field, ConfigDict
from typing import Dict, Optional, Literal


class LLMConfig(BaseModel):
    """LLM 配置 - 支持 ModelAdapter"""
    model_config = ConfigDict(extra='allow')

    # ModelAdapter 配置（新版本）
    provider: str = ""  # AI 提供商名称（openai/deepseek/openrouter）
    provider_type: str = ""  # Provider 类型（用于精确查找，避免同名冲突）
    model_name: str = "deepseek-chat"  # 默认 Chat 模型
    
    # 统一模型映射 (Task -> Model ID)
    model_map: Dict[str, str] = Field(default_factory=dict)
    
    temperature: float = 0.7
    max_tokens: int = 4096
    max_completion_tokens: int = 4096
    max_context_tokens: Optional[int] = None
    thinking_budget_tokens: Optional[int] = None
    reasoning_effort: Optional[str] = None
    timeout: int = 30
    retry_attempts: int = 10
    retry_backoff_factor: float = 2.5

    # 旧版配置（向后兼容）
    api_endpoint: str = "https://api.deepseek.com/v1"
    api_key: str = ""


class SystemConfig(BaseModel):
    """系统配置"""
    model_config = ConfigDict(extra='allow')

    max_content_length: int = 100 * 1024 * 1024  # 100MB (字节)


class EmbeddingConfig(BaseModel):
    """Embedding 配置 - 仅支持 ModelAdapter"""
    model_config = ConfigDict(extra='allow')

    provider: str = ""  # Embedding 提供商名称（留空表示未配置）
    provider_type: str = ""  # Provider 类型（用于精确查找，避免同名冲突）
    model_name: str = ""  # Embedding 模型名称
    batch_size: int = 100 # 批处理大小

class SQLiteVectorConfig(BaseModel):
    """SQLite + sqlite-vec 向量存储配置"""
    model_config = ConfigDict(extra='allow')

    database_path: str = ""  # 留空时由 path_resolution.RAGSYSTEM_DB 填充；相对路径解析到 DB_ROOT
    vector_dimension: int = 0  # 0=自动与当前 Embedding 模型一致
    distance_metric: str = "cosine"  # 距离度量: cosine, l2, ip


class PostgreSQLVectorConfig(BaseModel):
    """PostgreSQL + pgvector 向量存储配置（未来扩展）"""
    model_config = ConfigDict(extra='allow')

    host: str = "localhost"
    port: int = 5432
    database: str = "ragsystem"
    user: str = "postgres"
    password: str = ""
    vector_dimension: int = 0  # 0=自动与当前 Embedding 模型一致


class VectorStoreConfig(BaseModel):
    """向量存储配置"""
    model_config = ConfigDict(extra='allow')

    backend: str = "sqlite_vec"  # 后端类型: sqlite_vec, postgresql (未来)
    sqlite_vec: SQLiteVectorConfig = Field(default_factory=SQLiteVectorConfig)
    postgresql: PostgreSQLVectorConfig = Field(default_factory=PostgreSQLVectorConfig)


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

    enabled: bool = True
    workspace_trust: HooksWorkspaceTrustConfig = Field(default_factory=HooksWorkspaceTrustConfig)


class WaitingConfig(BaseModel):
    """后台任务等待与 KV cache 保活配置"""
    model_config = ConfigDict(extra='allow')

    enabled: bool = True
    default_poll_interval_seconds: float = 3.0
    max_poll_interval_seconds: float = 15.0
    idle_wait_timeout_seconds: float = 300.0
    local_cache_ttl_seconds: float = 600.0
    keepalive_interval_seconds: float = 240.0
    keepalive_grace_seconds: float = 30.0
    max_keepalive_rounds: int = 20
    allow_provider_keepalive: bool = True
    hidden_keepalive_token_budget: int = 8


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
