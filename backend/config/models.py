# -*- coding: utf-8 -*-
"""
配置数据模型 - 使用 Pydantic 提供类型安全和验证
"""

from pydantic import BaseModel, Field, ConfigDict
from typing import Dict, Any


class Neo4jConfig(BaseModel):
    """Neo4j 数据库配置"""
    model_config = ConfigDict(extra='allow')

    uri: str = "bolt://localhost:7687"
    user: str = "neo4j"
    password: str = ""


class LLMConfig(BaseModel):
    """LLM 配置 - 支持 LLMAdapter"""
    model_config = ConfigDict(extra='allow')

    # LLMAdapter 配置（新版本）
    provider: str = ""  # LLM 提供商名称（openai/deepseek/openrouter）
    model_name: str = "deepseek-chat"  # 模型名称
    temperature: float = 0.7
    max_tokens: int = 4096
    timeout: int = 30
    retry_attempts: int = 3

    # 旧版配置（向后兼容）
    api_endpoint: str = "https://api.deepseek.com/v1"
    api_key: str = ""


class SystemConfig(BaseModel):
    """系统配置"""
    model_config = ConfigDict(extra='allow')

    max_content_length: int = 100 * 1024 * 1024  # 100MB (字节)


class LocalEmbeddingConfig(BaseModel):
    """本地 Embedding 模型配置"""
    model_config = ConfigDict(extra='allow')

    model_name: str = "BAAI/bge-small-zh-v1.5"
    device: str = "cpu"
    cache_dir: str | None = None


class RemoteEmbeddingConfig(BaseModel):
    """远程 Embedding API 配置"""
    model_config = ConfigDict(extra='allow')

    api_endpoint: str = ""
    api_key: str = ""
    model_name: str = "text-embedding-3-small"
    timeout: int = 30
    max_retries: int = 3
    batch_size: int = 10  # 单次请求最多处理的文本数量（ModelScope 建议 10-20）


class EmbeddingConfig(BaseModel):
    """Embedding 配置"""
    model_config = ConfigDict(extra='allow')

    mode: str = "local"  # "local" 或 "remote"
    local: LocalEmbeddingConfig = Field(default_factory=LocalEmbeddingConfig)
    remote: RemoteEmbeddingConfig = Field(default_factory=RemoteEmbeddingConfig)


class SQLiteVectorConfig(BaseModel):
    """SQLite + sqlite-vec 向量存储配置"""
    model_config = ConfigDict(extra='allow')

    database_path: str = "data/vector_store.db"  # 数据库文件路径
    vector_dimension: int = 768  # 向量维度（需与 Embedding 模型匹配）
    distance_metric: str = "cosine"  # 距离度量: cosine, l2, ip


class PostgreSQLVectorConfig(BaseModel):
    """PostgreSQL + pgvector 向量存储配置（未来扩展）"""
    model_config = ConfigDict(extra='allow')

    host: str = "localhost"
    port: int = 5432
    database: str = "ragsystem"
    user: str = "postgres"
    password: str = ""
    vector_dimension: int = 768


class VectorStoreConfig(BaseModel):
    """向量存储配置"""
    model_config = ConfigDict(extra='allow')

    backend: str = "sqlite_vec"  # 后端类型: sqlite_vec, postgresql (未来)
    sqlite_vec: SQLiteVectorConfig = Field(default_factory=SQLiteVectorConfig)
    postgresql: PostgreSQLVectorConfig = Field(default_factory=PostgreSQLVectorConfig)


class ExternalLibsConfig(BaseModel):
    """外部库配置扩展 - 为 llmjson 和 json2graph 预留"""
    model_config = ConfigDict(extra='allow')

    llmjson: Dict[str, Any] = Field(default_factory=dict)
    json2graph: Dict[str, Any] = Field(default_factory=dict)


class AppConfig(BaseModel):
    """主配置模型"""
    model_config = ConfigDict(
        extra='allow',
        env_nested_delimiter='__',
        case_sensitive=False
    )

    neo4j: Neo4jConfig = Field(default_factory=Neo4jConfig)
    vector_store: VectorStoreConfig = Field(default_factory=VectorStoreConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    system: SystemConfig = Field(default_factory=SystemConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    external_libs: ExternalLibsConfig = Field(default_factory=ExternalLibsConfig)
