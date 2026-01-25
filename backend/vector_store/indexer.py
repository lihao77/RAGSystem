"""
文档索引构建器 - 负责文档分块和向量化索引
"""

import logging
import hashlib
import jieba
from typing import List, Dict, Optional, Any
from datetime import datetime

from .client import get_vector_client
from .embedder import get_embedder
from .base import Document

logger = logging.getLogger(__name__)


class DocumentIndexer:
    """文档索引构建器"""

    def __init__(self, collection_name: str = "documents"):
        """
        初始化索引器

        Args:
            collection_name: 集合名称
        """
        self.collection_name = collection_name
        self.vector_client = get_vector_client()
        self.embedder = get_embedder()

        # 确保客户端已初始化
        self.vector_client.ensure_initialized()
        self.embedder.ensure_initialized()

    @staticmethod
    def chunk_text(
        text: str,
        chunk_size: int = 500,
        overlap: int = 50,
        use_jieba: bool = True
    ) -> List[str]:
        """
        文本分块

        Args:
            text: 原始文本
            chunk_size: 分块大小（字符数）
            overlap: 重叠大小（字符数）
            use_jieba: 是否使用jieba优化分块边界

        Returns:
            分块文本列表
        """
        if not text or not text.strip():
            return []

        text = text.strip()
        chunks = []

        if use_jieba:
            # 使用jieba分句，避免在词中间切分
            sentences = list(jieba.cut(text, cut_all=False))

            current_chunk = []
            current_length = 0

            for sentence in sentences:
                sentence_length = len(sentence)

                if current_length + sentence_length > chunk_size and current_chunk:
                    # 达到分块大小，保存当前分块
                    chunks.append(''.join(current_chunk))

                    # 保留重叠部分
                    overlap_text = ''.join(current_chunk)[-overlap:]
                    current_chunk = [overlap_text, sentence]
                    current_length = len(overlap_text) + sentence_length
                else:
                    current_chunk.append(sentence)
                    current_length += sentence_length

            # 添加最后一个分块
            if current_chunk:
                chunks.append(''.join(current_chunk))
        else:
            # 简单按字符数切分
            start = 0
            while start < len(text):
                end = start + chunk_size
                chunks.append(text[start:end])
                start += chunk_size - overlap

        return chunks

    @staticmethod
    def _generate_chunk_id(document_id: str, index: int) -> str:
        """生成分块唯一ID"""
        hash_obj = hashlib.md5(document_id.encode('utf-8'))
        return f"{hash_obj.hexdigest()}_{index}"

    def index_document(
        self,
        document_id: str,
        text: str,
        metadata: Optional[Dict[str, Any]] = None,
        chunk_size: int = 500,
        overlap: int = 50
    ) -> int:
        """
        索引单个文档

        Args:
            document_id: 文档唯一标识
            text: 文档文本
            metadata: 文档元数据
            chunk_size: 分块大小
            overlap: 重叠大小

        Returns:
            索引的分块数量
        """
        try:
            # 文本分块
            chunks = self.chunk_text(text, chunk_size, overlap)
            if not chunks:
                logger.warning(f"文档 {document_id} 分块为空")
                return 0

            logger.info(f"文档 {document_id} 分为 {len(chunks)} 个分块")

            # 生成向量
            embeddings = self.embedder.embed(chunks)

            # 准备元数据
            base_metadata = metadata or {}
            base_metadata['document_id'] = document_id
            base_metadata['indexed_at'] = datetime.now().isoformat()

            # 构建 Document 对象
            documents = []
            for i, chunk in enumerate(chunks):
                chunk_metadata = base_metadata.copy()
                chunk_metadata.update({
                    'chunk_index': i,
                    'chunk_total': len(chunks),
                    'chunk_text_length': len(chunk)
                })

                doc = Document(
                    id=self._generate_chunk_id(document_id, i),
                    content=chunk,
                    metadata=chunk_metadata,
                    embedding=embeddings[i]
                )
                documents.append(doc)

            # 插入向量数据库
            self.vector_client.add_documents(
                documents=documents,
                collection=self.collection_name
            )

            logger.info(f"文档 {document_id} 索引完成，共 {len(chunks)} 个分块")
            return len(chunks)

        except Exception as e:
            logger.error(f"文档索引失败: {e}")
            raise

    def index_documents(
        self,
        documents: List[Dict[str, Any]],
        chunk_size: int = 500,
        overlap: int = 50
    ) -> Dict[str, int]:
        """
        批量索引文档

        Args:
            documents: 文档列表，每个文档包含 'id', 'text', 'metadata'
            chunk_size: 分块大小
            overlap: 重叠大小

        Returns:
            文档ID到分块数的映射
        """
        results = {}

        for doc in documents:
            doc_id = doc.get('id')
            text = doc.get('text')
            metadata = doc.get('metadata', {})

            if not doc_id or not text:
                logger.warning(f"跳过无效文档: {doc}")
                continue

            try:
                chunk_count = self.index_document(
                    document_id=doc_id,
                    text=text,
                    metadata=metadata,
                    chunk_size=chunk_size,
                    overlap=overlap
                )
                results[doc_id] = chunk_count

            except Exception as e:
                logger.error(f"文档 {doc_id} 索引失败: {e}")
                results[doc_id] = 0

        total_chunks = sum(results.values())
        logger.info(f"批量索引完成，总分块数: {total_chunks}")

        return results

    def delete_document(self, document_id: str):
        """删除文档的所有分块"""
        try:
            # 生成所有可能的分块 ID（假设最多 1000 个分块）
            # 注意：这是一个简化实现，实际可能需要先查询后删除
            chunk_ids = [self._generate_chunk_id(document_id, i) for i in range(1000)]

            # 删除文档
            deleted_count = self.vector_client.delete_documents(
                doc_ids=chunk_ids,
                collection=self.collection_name
            )

            logger.info(f"删除文档 {document_id}，共 {deleted_count} 个分块")

        except Exception as e:
            logger.error(f"删除文档失败: {e}")
            raise

    def get_collection_stats(self) -> Dict[str, Any]:
        """获取集合统计信息"""
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
            logger.error(f"获取统计信息失败: {e}")
            return {}
