"""
向量检索器 - 提供语义搜索功能
"""

import logging
from typing import List, Dict, Optional, Any

from .client import get_vector_client
from .embedder import get_embedder

logger = logging.getLogger(__name__)


class VectorRetriever:
    """向量检索器"""

    def __init__(self, collection_name: str = "documents"):
        """
        初始化检索器

        Args:
            collection_name: 集合名称
        """
        self.collection_name = collection_name
        self.vector_client = get_vector_client()
        self.embedder = get_embedder()

        # 确保客户端已初始化
        self.vector_client.ensure_initialized()
        self.embedder.ensure_initialized()

    def search(
        self,
        query: str,
        top_k: int = 5,
        filters: Optional[Dict[str, Any]] = None,
        include_distances: bool = True
    ) -> List[Dict[str, Any]]:
        """
        语义搜索

        Args:
            query: 查询文本
            top_k: 返回结果数量
            filters: 元数据过滤条件 (例如: {"category": "技术", "year": 2024})
            include_distances: 是否包含距离分数

        Returns:
            搜索结果列表，每个结果包含:
            - id: 分块ID
            - text: 分块文本
            - metadata: 元数据
            - distance: 距离值（可选）
            - similarity: 相似度分数 (0-1，越大越相似，可选)
        """
        try:
            # 查询向量化（传入列表以保证返回 list[list[float]]，再取第一个向量）
            query_embedding = self.embedder.embed([query])[0]

            # 执行向量检索
            results = self.vector_client.search(
                query_embedding=query_embedding,
                top_k=top_k,
                collection=self.collection_name,
                filters=filters
            )

            # 格式化结果
            formatted_results = []

            for result in results:
                formatted_result = {
                    'id': result.id,
                    'text': result.content,
                    'metadata': result.metadata
                }

                if include_distances:
                    formatted_result['distance'] = result.distance
                    formatted_result['similarity'] = result.score

                formatted_results.append(formatted_result)

            logger.info(f"检索完成，查询: '{query[:50]}...'，返回 {len(formatted_results)} 条结果")
            return formatted_results

        except Exception as e:
            logger.error(f"向量检索失败: {e}")
            raise

    def search_by_document(
        self,
        document_id: str,
        query: str,
        top_k: int = 5,
        include_distances: bool = True
    ) -> List[Dict[str, Any]]:
        """
        在特定文档内搜索

        Args:
            document_id: 文档ID
            query: 查询文本
            top_k: 返回结果数量
            include_distances: 是否包含距离分数

        Returns:
            搜索结果列表
        """
        return self.search(
            query=query,
            top_k=top_k,
            filters={"document_id": document_id},
            include_distances=include_distances
        )

    def get_similar_chunks(
        self,
        chunk_id: str,
        top_k: int = 5
    ) -> List[Dict[str, Any]]:
        """
        获取与指定分块相似的其他分块

        Args:
            chunk_id: 分块ID
            top_k: 返回结果数量

        Returns:
            相似分块列表
        """
        try:
            # 获取目标分块
            chunk = self.vector_client.get_document(
                doc_id=chunk_id,
                collection=self.collection_name
            )

            if not chunk or chunk.embedding is None:
                logger.warning(f"未找到分块: {chunk_id}")
                return []

            # 使用分块的 embedding 进行搜索
            results = self.vector_client.search(
                query_embedding=chunk.embedding,
                top_k=top_k + 1,  # +1 因为会包含自己
                collection=self.collection_name
            )

            # 格式化结果（排除自己）
            formatted_results = []

            for result in results:
                if result.id == chunk_id:
                    continue  # 跳过自己

                formatted_result = {
                    'id': result.id,
                    'text': result.content,
                    'metadata': result.metadata,
                    'distance': result.distance,
                    'similarity': result.score
                }
                formatted_results.append(formatted_result)

                if len(formatted_results) >= top_k:
                    break

            return formatted_results

        except Exception as e:
            logger.error(f"获取相似分块失败: {e}")
            raise

    def hybrid_search(
        self,
        query: str,
        keyword: Optional[str] = None,
        top_k: int = 5,
        filters: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """
        混合搜索（向量搜索 + 关键词过滤）

        Args:
            query: 查询文本
            keyword: 关键词（用于文本过滤）
            top_k: 返回结果数量
            filters: 元数据过滤条件

        Returns:
            搜索结果列表
        """
        # 先进行向量搜索
        results = self.search(
            query=query,
            top_k=top_k * 2 if keyword else top_k,  # 如果有关键词，先多取一些
            filters=filters,
            include_distances=True
        )

        # 如果有关键词，进行二次过滤
        if keyword:
            keyword_lower = keyword.lower()
            filtered_results = [
                r for r in results
                if keyword_lower in r['text'].lower()
            ]
            return filtered_results[:top_k]

        return results

    def get_collection_info(self) -> Dict[str, Any]:
        """获取集合信息"""
        try:
            info = self.vector_client.get_collection_info(self.collection_name)

            return {
                "collection_name": self.collection_name,
                "total_chunks": info.get("document_count", 0),
                "vector_dimension": info.get("vector_dimension", 0),
                "distance_metric": info.get("distance_metric", ""),
                "embedding_dimension": self.embedder.embedding_dim
            }
        except Exception as e:
            logger.error(f"获取集合信息失败: {e}")
            return {}
