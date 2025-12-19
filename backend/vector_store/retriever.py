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
            collection_name: ChromaDB集合名称
        """
        self.collection_name = collection_name
        self.vector_client = get_vector_client()
        self.embedder = get_embedder()
        self.collection = None
    
    def _ensure_collection(self):
        """确保集合已创建"""
        if self.collection is None:
            try:
                self.collection = self.vector_client.get_or_create_collection(
                    name=self.collection_name
                )
            except Exception as e:
                logger.error(f"获取集合失败: {e}")
                raise
    
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
            filters: 元数据过滤条件
            include_distances: 是否包含距离分数
            
        Returns:
            搜索结果列表，每个结果包含:
            - id: 分块ID
            - text: 分块文本
            - metadata: 元数据
            - distance: 距离分数（越小越相似，可选）
        """
        self._ensure_collection()
        
        try:
            # 查询向量化
            query_embedding = self.embedder.embed_query(query)
            
            # 执行向量检索
            results = self.collection.query(
                query_embeddings=[query_embedding],
                n_results=top_k,
                where=filters,
                include=['documents', 'metadatas', 'distances']
            )
            
            # 格式化结果
            formatted_results = []
            
            if results and results['ids'] and results['ids'][0]:
                for i in range(len(results['ids'][0])):
                    result = {
                        'id': results['ids'][0][i],
                        'text': results['documents'][0][i],
                        'metadata': results['metadatas'][0][i] if results['metadatas'][0] else {}
                    }
                    
                    if include_distances and results['distances'][0]:
                        distance = results['distances'][0][i]
                        result['distance'] = distance
                        # 转换为相似度分数 (0-1，越大越相似)
                        # ChromaDB 默认使用 L2 距离（平方欧氏距离）
                        # 相似度 = 1 / (1 + distance)，确保在 (0, 1] 范围内
                        result['similarity'] = 1.0 / (1.0 + distance)
                    
                    formatted_results.append(result)
            
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
        self._ensure_collection()
        
        try:
            # 获取目标分块
            chunk_data = self.collection.get(
                ids=[chunk_id],
                include=['documents', 'embeddings']
            )
            
            if not chunk_data or not chunk_data['documents']:
                logger.warning(f"未找到分块: {chunk_id}")
                return []
            
            # 使用分块的embedding进行搜索
            chunk_embedding = chunk_data['embeddings'][0]
            
            results = self.collection.query(
                query_embeddings=[chunk_embedding],
                n_results=top_k + 1,  # +1 因为会包含自己
                include=['documents', 'metadatas', 'distances']
            )
            
            # 格式化结果（排除自己）
            formatted_results = []
            
            if results and results['ids'] and results['ids'][0]:
                for i in range(len(results['ids'][0])):
                    if results['ids'][0][i] == chunk_id:
                        continue  # 跳过自己
                    
                    distance = results['distances'][0][i]
                    result = {
                        'id': results['ids'][0][i],
                        'text': results['documents'][0][i],
                        'metadata': results['metadatas'][0][i] if results['metadatas'][0] else {},
                        'distance': distance,
                        'similarity': 1.0 / (1.0 + distance)
                    }
                    formatted_results.append(result)
                    
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
        self._ensure_collection()
        
        try:
            count = self.collection.count()
            
            # 获取一些示例文档
            sample = self.collection.peek(limit=3)
            
            return {
                "collection_name": self.collection_name,
                "total_chunks": count,
                "embedding_dimension": self.embedder.embedding_dim,
                "model_name": self.embedder.model_name,
                "sample_ids": sample['ids'] if sample and sample['ids'] else []
            }
        except Exception as e:
            logger.error(f"获取集合信息失败: {e}")
            return {}
