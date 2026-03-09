# -*- coding: utf-8 -*-
"""
文本向量化器 - 统一的 Embedding 接口

支持多种 Embedding 方式:
1. 远程 API (推荐): OpenAI、DeepSeek、智谱等兼容服务
2. 自定义模型: 通过 HTTP API 调用自建服务

不再依赖 sentence-transformers 和 PyTorch，大幅减少依赖体积。
"""

import logging
from typing import List, Union, Optional
from abc import ABC, abstractmethod

# 引入 Model Adapter 的 Provider
from model_adapter.providers import OpenAIProvider, ModelScopeProvider
from model_adapter.base import AIProvider

logger = logging.getLogger(__name__)


class EmbedderBase(ABC):
    """Embedder 抽象基类"""

    @abstractmethod
    def embed(self, texts: Union[str, List[str]]) -> List[List[float]]:
        """
        文本向量化

        Args:
            texts: 单个文本或文本列表

        Returns:
            向量列表，每个向量是 float 列表
        """
        pass

    @property
    @abstractmethod
    def embedding_dim(self) -> int:
        """获取向量维度"""
        pass


class RemoteEmbedder(EmbedderBase):
    """
    远程 API Embedder (基于 Model Adapter 实现)
    """

    def __init__(
        self,
        provider_name: str,
        model_name: str = "text-embedding-3-small",
        batch_size: int = 100,
        provider_type: Optional[str] = None
    ):
        """
        初始化远程 Embedder
        
        Args:
            provider_name: Model Adapter Provider 名称
            model_name: 模型名称
            batch_size: 批处理大小
            provider_type: Provider 类型
        """
        self.model_name = model_name
        self.batch_size = batch_size
        
        # 获取 Model Adapter 实例
        from model_adapter.adapter import get_default_adapter
        self.adapter = get_default_adapter()
        
        # 确保 Provider 已加载
        try:
            self.provider = self.adapter.get_provider(provider_name, provider_type)
        except ValueError as e:
            # 尝试重新加载配置
            self.adapter._load_saved_configs()
            try:
                self.provider = self.adapter.get_provider(provider_name, provider_type)
            except ValueError:
                # 提供更详细的错误信息
                if provider_type:
                    raise ValueError(
                        f"未找到 Provider: {provider_name}_{provider_type}，"
                        f"请先在 Model Adapter 中配置"
                    )
                else:
                    raise ValueError(
                        f"未找到 Provider: {provider_name}。{str(e)}\n"
                        f"提示：如果有多个同名 Provider，请在配置中添加 provider_type"
                    )

        # 缓存向量维度
        self._embedding_dim: Optional[int] = None

        provider_key = f"{provider_name}_{provider_type}" if provider_type else provider_name
        logger.info(f"✅ 远程 Embedder 已初始化 (via Model Adapter)")
        logger.info(f"   Provider: {provider_key}")
        logger.info(f"   模型: {model_name}")

    def embed(self, texts: Union[str, List[str]]) -> List[List[float]]:
        """文本向量化"""
        # 统一处理为列表
        single_text = False
        if isinstance(texts, str):
            texts = [texts]
            single_text = True
        
        if not texts:
            return []

        # 批处理
        all_embeddings = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i:i + self.batch_size]
            
            # 使用 Model Adapter 的 embed 接口
            # 注意：Model Adapter 的 embed 接口可能需要适配
            # 目前 Provider 类直接暴露了 embed 方法，我们可以直接调用
            
            response = self.provider.embed(
                texts=batch,
                model=self.model_name
            )
            
            # 检查 response 是否为 None（理论上不应该，但为了安全）
            if response is None:
                raise RuntimeError("Embedding 调用失败: Provider 返回 None")
            
            if response.error:
                 raise RuntimeError(f"Embedding 调用失败: {response.error}")
                 
            all_embeddings.extend(response.embeddings)

        if single_text:
            return all_embeddings[0]

        return all_embeddings

    @property
    def embedding_dim(self) -> int:
        """获取向量维度"""
        if self._embedding_dim is None:
            # 通过一个测试文本获取维度
            try:
                embeddings = self.embed("test")
                # 如果是单条文本返回的是 list[float]，如果是多条返回 list[list[float]]
                # 上面的 embed 实现：如果输入 str 返回 list[float]
                if embeddings and isinstance(embeddings, list):
                     self._embedding_dim = len(embeddings)
                else:
                    raise RuntimeError("无法获取向量维度")
            except Exception as e:
                logger.error(f"获取向量维度失败: {e}")
                # 不返回虚假维度，让调用方知道 Embedder 未就绪
                raise RuntimeError(
                    f"无法获取向量维度（Embedding 接口调用失败）。请检查 Provider/API 配置。原因: {e}"
                ) from e

        return self._embedding_dim


class TextEmbedder:
    """
    统一的 Embedder 接口（单例模式）

    根据配置自动选择合适的 Embedder 实现
    """

    _instance: Optional['TextEmbedder'] = None
    _embedder: Optional[EmbedderBase] = None
    _initialized: bool = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        logger.info("TextEmbedder 已创建（延迟初始化）")

    def reset(self):
        """重置内部 Embedder，使下次 initialize/embed 时按当前配置重新初始化（用于配置热重载）。"""
        self._embedder = None
        logger.debug("Embedder 已重置，下次使用将按当前配置重新初始化")

    def initialize(self, config=None, force=False):
        """
        初始化 Embedder（仅从向量库管理配置的「当前激活向量化器」读取，不读 config.embedding）。
        """
        if force:
            self.reset()
        if self._embedder is not None:
            logger.debug("Embedder 已初始化，跳过重复初始化")
            return

        from .vectorizer_config import get_vectorizer_config_store

        store = get_vectorizer_config_store()
        active_key = store.get_active_key()
        if not active_key:
            logger.warning("未配置激活的向量化器，Embedder 将不可用。请在向量库管理中添加并激活向量化器。")
            return

        cfg = store.get_vectorizer(active_key)
        if not cfg:
            logger.warning("激活的向量化器配置不存在: %s", active_key)
            return

        provider_key = cfg.get("provider_key") or ""
        model_name = cfg.get("model_name") or ""
        if not provider_key or not model_name:
            logger.warning("向量化器配置缺少 provider_key 或 model_name: %s", active_key)
            return

        # Model Adapter 的 provider 可能带 type：provider_key 存的是名称，provider_type 可选
        provider_type = cfg.get("provider_type")
        provider_name = provider_key
        try:
            self._embedder = RemoteEmbedder(
                provider_name=provider_name,
                model_name=model_name,
                batch_size=cfg.get("batch_size", 100),
                provider_type=provider_type
            )
            logger.info("✅ Embedder 初始化完成 (向量化器: %s)", active_key)
        except ValueError as e:
            logger.warning("Embedder 初始化失败: %s", e)
            self._embedder = None

    def embed(self, texts: Union[str, List[str]]) -> List[List[float]]:
        """
        文本向量化

        Args:
            texts: 单个文本或文本列表

        Returns:
            向量列表
        """
        if self._embedder is None:
            self.initialize()
            
        if self._embedder is None:
            raise RuntimeError("Embedder 未初始化，请在向量库管理中配置并激活向量化器")

        return self._embedder.embed(texts)

    @property
    def embedding_dim(self) -> int:
        """获取向量维度"""
        if self._embedder is None:
            self.initialize()
            
        if self._embedder is None:
            raise RuntimeError("Embedder 未初始化或初始化失败，请在向量库管理中配置并激活向量化器")

        return self._embedder.embedding_dim

    def ensure_initialized(self):
        """确保已初始化"""
        if self._embedder is None:
            self.initialize()


# 全局单例
_text_embedder: Optional[TextEmbedder] = None


def get_embedder() -> TextEmbedder:
    """
    获取全局 TextEmbedder 单例

    Returns:
        TextEmbedder 实例
    """
    global _text_embedder
    if _text_embedder is None:
        _text_embedder = TextEmbedder()
    return _text_embedder


def reset_embedder():
    """重置全局 Embedder 单例的内部实现，使配置重载后下次调用使用新配置。"""
    embedder = get_embedder()
    embedder.reset()


def get_embedder_for_vectorizer(vectorizer_key: str) -> Optional[EmbedderBase]:
    """
    按向量化器键创建并返回一个 Embedder 实例（用于迁移等场景，不缓存）。
    若该键不存在或创建失败则返回 None。
    """
    from .vectorizer_config import get_vectorizer_config_store
    store = get_vectorizer_config_store()
    cfg = store.get_vectorizer(vectorizer_key)
    if not cfg:
        return None
    provider_key = cfg.get("provider_key") or ""
    model_name = cfg.get("model_name") or ""
    if not provider_key or not model_name:
        return None
    try:
        return RemoteEmbedder(
            provider_name=provider_key,
            model_name=model_name,
            batch_size=cfg.get("batch_size", 100),
            provider_type=cfg.get("provider_type")
        )
    except ValueError:
        return None
