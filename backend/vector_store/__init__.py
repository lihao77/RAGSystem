# -*- coding: utf-8 -*-
"""
向量数据库模块 (重构版)

基于 SQLite + sqlite-vec 的向量存储系统
- 零依赖部署（单文件数据库）
- SQL 原生支持（强大的元数据过滤）
- 易于迁移到 PostgreSQL + pgvector
"""

from .base import VectorStoreBase, Document, SearchResult
from .client import get_vector_client, VectorStoreClient
from .embedder import get_embedder, TextEmbedder
from .indexer import DocumentIndexer
from .retriever import VectorRetriever

__all__ = [
    # 基础类
    'VectorStoreBase',
    'Document',
    'SearchResult',

    # 客户端
    'get_vector_client',
    'VectorStoreClient',

    # Embedder
    'get_embedder',
    'TextEmbedder',

    # 索引和检索
    'DocumentIndexer',
    'VectorRetriever'
]

__version__ = '2.0.0'
