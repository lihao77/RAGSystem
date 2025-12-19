"""
文本向量化器 - 使用sentence-transformers生成文本嵌入
"""

import logging
from typing import List, Union, Optional
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)


class TextEmbedder:
    """文本向量化器"""
    
    _instance: Optional['TextEmbedder'] = None
    _model: Optional[SentenceTransformer] = None
    
    # 默认模型：多语言支持，轻量级
    DEFAULT_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2'
    
    def __new__(cls, model_name: str = None):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self, model_name: str = None):
        if self._model is None:
            self._load_model(model_name or self.DEFAULT_MODEL)
    
    def _load_model(self, model_name: str):
        """加载sentence-transformers模型"""
        try:
            logger.info(f"加载embedding模型: {model_name}")
            self._model = SentenceTransformer(model_name)
            self._model_name = model_name
            logger.info(f"模型加载成功，向量维度: {self.embedding_dim}")
            
        except Exception as e:
            logger.error(f"模型加载失败: {e}")
            raise
    
    @property
    def model(self) -> SentenceTransformer:
        """获取模型实例"""
        if self._model is None:
            self._load_model(self.DEFAULT_MODEL)
        return self._model
    
    @property
    def embedding_dim(self) -> int:
        """获取向量维度"""
        return self.model.get_sentence_embedding_dimension()
    
    @property
    def model_name(self) -> str:
        """获取模型名称"""
        return self._model_name
    
    def embed_text(self, text: str) -> List[float]:
        """
        将单个文本转换为向量
        
        Args:
            text: 输入文本
            
        Returns:
            向量列表
        """
        try:
            if not text or not text.strip():
                raise ValueError("输入文本不能为空")
            
            embedding = self.model.encode(text, convert_to_numpy=True)
            return embedding.tolist()
            
        except Exception as e:
            logger.error(f"文本向量化失败: {e}")
            raise
    
    def embed_texts(self, texts: List[str]) -> List[List[float]]:
        """
        批量将文本转换为向量
        
        Args:
            texts: 文本列表
            
        Returns:
            向量列表的列表
        """
        try:
            if not texts:
                return []
            
            # 过滤空文本
            valid_texts = [t for t in texts if t and t.strip()]
            if not valid_texts:
                raise ValueError("所有文本都为空")
            
            # 批量编码
            embeddings = self.model.encode(
                valid_texts,
                convert_to_numpy=True,
                show_progress_bar=len(valid_texts) > 10  # 超过10条显示进度
            )
            
            return embeddings.tolist()
            
        except Exception as e:
            logger.error(f"批量文本向量化失败: {e}")
            raise
    
    def embed_query(self, query: str) -> List[float]:
        """
        查询文本向量化（别名方法，语义更清晰）
        
        Args:
            query: 查询文本
            
        Returns:
            向量列表
        """
        return self.embed_text(query)


# 全局单例实例
_embedder = None


def get_embedder(model_name: str = None) -> TextEmbedder:
    """获取全局TextEmbedder实例"""
    global _embedder
    if _embedder is None:
        _embedder = TextEmbedder(model_name)
    return _embedder
