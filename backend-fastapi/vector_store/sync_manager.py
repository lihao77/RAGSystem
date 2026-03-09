# -*- coding: utf-8 -*-
"""
向量同步管理器

负责增量同步向量数据到不同的 embedding 模型。
"""

import logging
import json
import struct
from typing import List, Dict, Any, Optional
# from tqdm import tqdm

from .model_manager import EmbeddingModelManager, EmbeddingModelInfo
from .embedder import get_embedder, RemoteEmbedder
from .base import Document

logger = logging.getLogger(__name__)


class VectorSyncManager:
    """向量同步管理器"""

    def __init__(self, db_path: str, model_manager: EmbeddingModelManager):
        self.db_path = db_path
        self.model_manager = model_manager
        # Note: In a real scenario, we might need to instantiate different embedders per model
        # For now, we assume get_embedder() returns the configured one, 
        # but we might need to support switching configurations.
        self.embedder = get_embedder()

    def get_unsync_documents(
        self,
        model_id: int,
        collection: str = "default",
        limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        获取尚未为指定模型生成向量的文档

        Args:
            model_id: 模型 ID
            collection: 集合名称
            limit: 最多返回数量（None 表示全部）

        Returns:
            文档列表 [{"id": "doc1", "content": "...", "metadata": {}}, ...]
        """
        import sqlite3
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row

        # 查询缺少该模型向量的文档
        query = """
            SELECT d.id, d.content, d.metadata
            FROM documents d
            WHERE d.collection = ?
              AND NOT EXISTS (
                  SELECT 1 FROM document_vectors dv
                  WHERE dv.doc_id = d.id
                    AND dv.collection = d.collection
                    AND dv.model_id = ?
              )
        """

        params = [collection, model_id]

        if limit:
            query += " LIMIT ?"
            params.append(limit)

        cursor = conn.execute(query, params)
        rows = cursor.fetchall()

        documents = []
        for row in rows:
            documents.append({
                "id": row['id'],
                "content": row['content'],
                "metadata": json.loads(row['metadata']) if row['metadata'] else {}
            })

        conn.close()

        logger.info(f"找到 {len(documents)} 个文档需要同步到模型 {model_id}")
        return documents

    def sync_documents_to_model(
        self,
        model_id: int,
        collection: str = "default",
        batch_size: int = 50,
        limit: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        将文档同步到指定模型（增量）

        Args:
            model_id: 目标模型 ID
            collection: 集合名称
            batch_size: 批处理大小
            limit: 最多同步数量

        Returns:
            同步结果统计
        """
        # 1. 获取模型信息
        model_info = self.model_manager.get_model_by_id(model_id)
        if model_info is None:
            raise ValueError(f"模型不存在: ID={model_id}")

        logger.info(f"开始同步到模型: {model_info.model_key}")

        # 2. 获取待同步文档
        unsync_docs = self.get_unsync_documents(model_id, collection, limit)

        if not unsync_docs:
            logger.info("✓ 没有需要同步的文档")
            return {
                "model_id": model_id,
                "model_key": model_info.model_key,
                "collection": collection,
                "total_documents": 0,
                "synced_count": 0,
                "failed_count": 0,
                "skipped_count": 0
            }

        # 3. 切换 Embedder 配置（如果需要）
        # 这里需要根据 model_info 动态配置 embedder
        # 我们创建一个临时的 embedder 实例
        temp_embedder = self._create_temp_embedder(model_info)

        # 4. 批量编码并存储
        synced_count = 0
        failed_count = 0

        import sqlite3
        conn = sqlite3.connect(self.db_path)

        # Use simple range if tqdm not available
        iterator = range(0, len(unsync_docs), batch_size)
        try:
            from tqdm import tqdm
            iterator = tqdm(iterator, desc=f"同步到 {model_info.model_key}")
        except ImportError:
            pass

        for i in iterator:
            batch = unsync_docs[i:i + batch_size]

            # 提取文本
            texts = [doc['content'] for doc in batch]

            try:
                # 批量编码
                embeddings = temp_embedder.embed(texts)

                # 批量插入向量
                for doc, embedding in zip(batch, embeddings):
                    embedding_blob = self._serialize_vector(embedding)

                    conn.execute(
                        """
                        INSERT INTO document_vectors (doc_id, collection, model_id, embedding)
                        VALUES (?, ?, ?, ?)
                        """,
                        (doc['id'], collection, model_id, embedding_blob)
                    )

                conn.commit()
                synced_count += len(batch)

            except Exception as e:
                logger.error(f"批次同步失败: {e}")
                failed_count += len(batch)
                continue

        conn.close()

        logger.info(f"✓ 同步完成: 成功 {synced_count}，失败 {failed_count}")

        return {
            "model_id": model_id,
            "model_key": model_info.model_key,
            "collection": collection,
            "total_documents": len(unsync_docs),
            "synced_count": synced_count,
            "failed_count": failed_count,
            "skipped_count": 0
        }

    def sync_all_collections_to_model(
        self,
        model_id: int,
        batch_size: int = 50
    ) -> Dict[str, Any]:
        """
        同步所有集合到指定模型

        Returns:
            汇总统计
        """
        import sqlite3
        conn = sqlite3.connect(self.db_path)
        cursor = conn.execute("SELECT name FROM collections")
        collections = [row[0] for row in cursor.fetchall()]
        conn.close()

        total_synced = 0
        total_failed = 0
        results_by_collection = {}

        for collection_name in collections:
            result = self.sync_documents_to_model(model_id, collection_name, batch_size)
            total_synced += result['synced_count']
            total_failed += result['failed_count']
            results_by_collection[collection_name] = result

        return {
            "model_id": model_id,
            "total_synced": total_synced,
            "total_failed": total_failed,
            "collections": results_by_collection
        }
    
    def _create_temp_embedder(self, model_info: EmbeddingModelInfo):
        """根据模型信息创建 Embedder 实例"""
        
        if model_info.provider == 'local':
             raise NotImplementedError("Local embedder not supported in sync manager yet")
        else:
            # 尝试从 Model Adapter 获取已配置的 Provider
            try:
                from model_adapter import get_default_adapter
                adapter = get_default_adapter()
                
                # 遍历查找匹配的 Provider
                # 这里简单匹配 provider_type
                # 更严谨的做法是匹配 api_endpoint 或者 name
                for provider in adapter.providers.values():
                    if provider.provider_type.value == model_info.provider:
                        logger.info(f"复用 Model Adapter 中的 Provider: {provider.name}")
                        return RemoteEmbedder(
                            api_endpoint=provider.api_endpoint,
                            api_key=provider.api_key,
                            model_name=model_info.model_name
                        )
            except Exception as e:
                logger.warning(f"无法从 Model Adapter 获取 Provider: {e}")

            # 如果未找到，尝试从 Config 获取 (Legacy)
            from config import get_config
            config = get_config()
            
            api_key = ""
            if config.embedding.mode == 'remote' and config.embedding.remote.api_endpoint == model_info.api_endpoint:
                api_key = config.embedding.remote.api_key
            else:
                # Try to guess or use env vars
                import os
                if model_info.provider == 'openai':
                    api_key = os.getenv("OPENAI_API_KEY", "")
                elif model_info.provider == 'deepseek':
                    api_key = os.getenv("DEEPSEEK_API_KEY", "")
                elif model_info.provider == 'custom':
                     api_key = os.getenv("CUSTOM_API_KEY", "") 
            
            return RemoteEmbedder(
                api_endpoint=model_info.api_endpoint,
                api_key=api_key,
                model_name=model_info.model_name
            )

    def _serialize_vector(self, vector: List[float]) -> bytes:
        """序列化向量为 BLOB"""
        return struct.pack(f"{len(vector)}f", *vector)
