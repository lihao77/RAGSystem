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

logger = logging.getLogger(__name__)


class DocumentIndexer:
    """文档索引构建器"""
    
    def __init__(self, collection_name: str = "documents"):
        """
        初始化索引器
        
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
            self.collection = self.vector_client.get_or_create_collection(
                name=self.collection_name,
                metadata={
                    "description": "文档向量索引",
                    "created_at": datetime.now().isoformat()
                }
            )
    
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
    def _generate_chunk_id(text: str, index: int) -> str:
        """生成分块唯一ID"""
        hash_obj = hashlib.md5(text.encode('utf-8'))
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
        self._ensure_collection()
        
        try:
            # 文本分块
            chunks = self.chunk_text(text, chunk_size, overlap)
            if not chunks:
                logger.warning(f"文档 {document_id} 分块为空")
                return 0
            
            logger.info(f"文档 {document_id} 分为 {len(chunks)} 个分块")
            
            # 生成向量
            embeddings = self.embedder.embed_texts(chunks)
            
            # 准备元数据
            base_metadata = metadata or {}
            base_metadata['document_id'] = document_id
            base_metadata['indexed_at'] = datetime.now().isoformat()
            
            # 构建ChromaDB所需数据
            ids = [self._generate_chunk_id(document_id, i) for i in range(len(chunks))]
            metadatas = []
            for i, chunk in enumerate(chunks):
                chunk_metadata = base_metadata.copy()
                chunk_metadata.update({
                    'chunk_index': i,
                    'chunk_total': len(chunks),
                    'chunk_text_length': len(chunk)
                })
                metadatas.append(chunk_metadata)
            
            # 插入向量数据库
            self.collection.add(
                ids=ids,
                embeddings=embeddings,
                documents=chunks,
                metadatas=metadatas
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
        self._ensure_collection()
        
        try:
            # 查询所有属于该文档的分块
            results = self.collection.get(
                where={"document_id": document_id}
            )
            
            if results and results['ids']:
                self.collection.delete(ids=results['ids'])
                logger.info(f"删除文档 {document_id}，共 {len(results['ids'])} 个分块")
            else:
                logger.warning(f"未找到文档 {document_id}")
                
        except Exception as e:
            logger.error(f"删除文档失败: {e}")
            raise
    
    def get_collection_stats(self) -> Dict[str, Any]:
        """获取集合统计信息"""
        self._ensure_collection()
        
        try:
            count = self.collection.count()
            return {
                "collection_name": self.collection_name,
                "total_chunks": count,
                "embedding_dimension": self.embedder.embedding_dim,
                "model_name": self.embedder.model_name
            }
        except Exception as e:
            logger.error(f"获取统计信息失败: {e}")
            return {}
