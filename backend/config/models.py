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
    """LLM API 配置"""
    model_config = ConfigDict(extra='allow')

    api_endpoint: str = "https://api.deepseek.com/v1"
    api_key: str = ""
    model_name: str = "deepseek-chat"
    temperature: float = 0.7
    max_tokens: int = 4096


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


class EmbeddingConfig(BaseModel):
    """Embedding 配置"""
    model_config = ConfigDict(extra='allow')

    mode: str = "local"  # "local" 或 "remote"
    local: LocalEmbeddingConfig = Field(default_factory=LocalEmbeddingConfig)
    remote: RemoteEmbeddingConfig = Field(default_factory=RemoteEmbeddingConfig)


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
    llm: LLMConfig = Field(default_factory=LLMConfig)
    system: SystemConfig = Field(default_factory=SystemConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    external_libs: ExternalLibsConfig = Field(default_factory=ExternalLibsConfig)
