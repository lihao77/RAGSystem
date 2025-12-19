# -*- coding: utf-8 -*-
"""
向量数据库模块

提供文档向量化、索引构建和语义检索功能
"""

from .client import get_vector_client, VectorStoreClient
from .embedder import get_embedder, TextEmbedder
from .indexer import DocumentIndexer
from .retriever import VectorRetriever

__all__ = [
    'get_vector_client',
    'VectorStoreClient',
    'get_embedder',
    'TextEmbedder',
    'DocumentIndexer',
    'VectorRetriever'
]

__version__ = '1.0.0'
