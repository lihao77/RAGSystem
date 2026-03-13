# -*- coding: utf-8 -*-
"""
配置数据模型 - 使用 Pydantic 提供类型安全和验证
"""

from pydantic import BaseModel, Field, ConfigDict
from typing import Dict, Optional


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
    retry_attempts: int = 3

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

    database_path: str = "data/vector_store.db"  # 数据库文件路径
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
