# -*- coding: utf-8 -*-
"""
向量存储抽象基类

提供统一的向量存储接口，支持多种后端实现：
- SQLiteVectorStore: SQLite + sqlite-vec (推荐)
- PostgreSQLVectorStore: PostgreSQL + pgvector (未来扩展)
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass


@dataclass
class Document:
    """文档数据模型"""
    id: str
    content: str
    metadata: Dict[str, Any]
    embedding: Optional[List[float]] = None


@dataclass
class SearchResult:
    """检索结果数据模型"""
    id: str
    content: str
    metadata: Dict[str, Any]
    score: float  # 相似度分数 (0-1, 越高越相似)
    distance: float  # 距离值（具体含义取决于距离度量）


class VectorStoreBase(ABC):
    """向量存储抽象基类"""

    @abstractmethod
    def initialize(self) -> None:
        """初始化向量存储（建表、索引等）"""
        pass

    @abstractmethod
    def add_documents(
        self,
        documents: List[Document],
        collection: str = "default"
    ) -> None:
        """
        添加文档到向量存储

        Args:
            documents: 文档列表（必须包含 embedding）
            collection: 集合名称（类似 ChromaDB 的 collection）
        """
        pass

    @abstractmethod
    def search(
        self,
        query_embedding: List[float],
        top_k: int = 10,
        collection: str = "default",
        filters: Optional[Dict[str, Any]] = None
    ) -> List[SearchResult]:
        """
        向量相似度检索

        Args:
            query_embedding: 查询向量
            top_k: 返回结果数量
            collection: 集合名称
            filters: 元数据过滤条件（SQL WHERE 子句）
                     例如: {"category": "技术", "year": 2024}

        Returns:
            检索结果列表（按相似度降序）
        """
        pass

    @abstractmethod
    def get_document(
        self,
        doc_id: str,
        collection: str = "default"
    ) -> Optional[Document]:
        """
        根据 ID 获取文档

        Args:
            doc_id: 文档 ID
            collection: 集合名称

        Returns:
            文档对象，不存在则返回 None
        """
        pass

    @abstractmethod
    def delete_documents(
        self,
        doc_ids: List[str],
        collection: str = "default"
    ) -> int:
        """
        删除文档

        Args:
            doc_ids: 文档 ID 列表
            collection: 集合名称

        Returns:
            删除的文档数量
        """
        pass

    @abstractmethod
    def list_collections(self) -> List[str]:
        """
        列出所有集合

        Returns:
            集合名称列表
        """
        pass

    @abstractmethod
    def delete_collection(self, collection: str) -> None:
        """
        删除集合（及其所有文档）

        Args:
            collection: 集合名称
        """
        pass

    @abstractmethod
    def count_documents(self, collection: str = "default") -> int:
        """
        统计集合中的文档数量

        Args:
            collection: 集合名称

        Returns:
            文档数量
        """
        pass

    @abstractmethod
    def get_collection_info(self, collection: str = "default") -> Dict[str, Any]:
        """
        获取集合信息

        Args:
            collection: 集合名称

        Returns:
            集合信息字典（包含文档数量、向量维度等）
        """
        pass

    @abstractmethod
    def close(self) -> None:
        """关闭连接，释放资源"""
        pass

    # 可选：批量操作优化
    def batch_search(
        self,
        query_embeddings: List[List[float]],
        top_k: int = 10,
        collection: str = "default",
        filters: Optional[Dict[str, Any]] = None
    ) -> List[List[SearchResult]]:
        """
        批量检索（默认实现为循环调用 search）

        子类可以重写此方法进行性能优化

        Args:
            query_embeddings: 查询向量列表
            top_k: 每个查询返回的结果数量
            collection: 集合名称
            filters: 元数据过滤条件

        Returns:
            每个查询的结果列表
        """
        results = []
        for query_embedding in query_embeddings:
            result = self.search(
                query_embedding=query_embedding,
                top_k=top_k,
                collection=collection,
                filters=filters
            )
            results.append(result)
        return results
