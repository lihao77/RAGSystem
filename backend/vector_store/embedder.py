"""
文本向量化器 - 支持本地模型和远程 API
"""

import logging
from typing import List, Union, Optional
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)


class TextEmbedder:
    """文本向量化器（单例模式，延迟初始化）"""
    
    _instance: Optional['TextEmbedder'] = None
    _model: Optional[SentenceTransformer] = None
    _model_name: Optional[str] = None
    
    # 默认模型：多语言支持，轻量级
    DEFAULT_MODEL = 'BAAI/bge-small-zh-v1.5'
    
    def __new__(cls, model_name: str = None):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self, model_name: str = None):
        # 如果模型已经加载且模型名称相同，跳过重复加载
        target_model = model_name or self.DEFAULT_MODEL
        
        if self._model is not None:
            if self._model_name == target_model:
                logger.debug(f"模型已加载，跳过重复初始化: {self._model_name}")
                return
            else:
                # 模型切换
                logger.info(f"检测到模型切换: {self._model_name} -> {target_model}")
                self._load_model(target_model)
        else:
            # 首次加载
            self._load_model(target_model)
    
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
    """
    获取全局TextEmbedder实例（单例）
    
    Args:
        model_name: 模型名称，如果为None则使用默认模型
        
    Returns:
        TextEmbedder实例
    """
    global _embedder
    if _embedder is None:
        _embedder = TextEmbedder(model_name)
    elif model_name is not None:
        # 如果指定了模型名称，确保使用正确的模型
        _embedder.__init__(model_name)
    return _embedder


def create_embedder_from_config(config):
    """
    从配置创建 Embedder（使用单例，避免重复初始化）
    
    根据配置的 embedding.mode 选择本地或远程模式
    
    Args:
        config: 配置对象
    
    Returns:
        TextEmbedder 或 RemoteEmbedder 实例
    """
    global _embedder
    
    mode = config.embedding.mode.lower()
    
    if mode == "local":
        # 本地模式 - 使用单例
        logger.info("使用本地 Embedding 模型")
        local_config = config.embedding.local
        
        # 复用全局单例，避免重复初始化
        if _embedder is None:
            _embedder = TextEmbedder(model_name=local_config.model_name)
        else:
            # 如果已存在，检查是否需要切换模型
            _embedder.__init__(model_name=local_config.model_name)
        
        return _embedder
    
    elif mode == "remote":
        # 远程模式
        logger.info("使用远程 Embedding API")
        from vector_store.remote_embedder import create_remote_embedder_from_config
        
        return create_remote_embedder_from_config(config)
    
    else:
        raise ValueError(f"不支持的 embedding 模式: {mode}，请使用 'local' 或 'remote'")
