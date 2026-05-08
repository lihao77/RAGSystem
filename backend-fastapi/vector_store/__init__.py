# -*- coding: utf-8 -*-
"""
向量数据库模块 (重构版)

基于 SQLite + sqlite-vec 的向量存储系统
- 零依赖部署（单文件数据库）
- SQL 原生支持（强大的元数据过滤）
"""

from .base import VectorStoreBase, Document, SearchResult


def __getattr__(name):
    if name in {"get_vector_client", "VectorStoreClient"}:
        from .client import get_vector_client, VectorStoreClient
        return {"get_vector_client": get_vector_client, "VectorStoreClient": VectorStoreClient}[name]
    if name in {"get_embedder", "TextEmbedder"}:
        from .embedder import get_embedder, TextEmbedder
        return {"get_embedder": get_embedder, "TextEmbedder": TextEmbedder}[name]
    if name == "DocumentIndexer":
        from .indexer import DocumentIndexer
        return DocumentIndexer
    if name == "VectorRetriever":
        from .retriever import VectorRetriever
        return VectorRetriever
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

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
