# -*- coding: utf-8 -*-
"""
文本向量化器 - 统一的 Embedding 接口

支持多种 Embedding 方式:
1. 远程 API (推荐): OpenAI、DeepSeek、智谱等兼容服务
2. 自定义模型: 通过 HTTP API 调用自建服务

不再依赖 sentence-transformers 和 PyTorch，大幅减少依赖体积。
"""

import logging
import requests
from typing import List, Union, Optional
from abc import ABC, abstractmethod

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
    远程 API Embedder

    支持 OpenAI 兼容的 Embedding API:
    - OpenAI: https://api.openai.com/v1
    - DeepSeek: https://api.deepseek.com/v1
    - 智谱 AI: https://open.bigmodel.cn/api/paas/v4
    - 自建服务: 任何兼容 OpenAI 格式的服务
    """

    def __init__(
        self,
        api_endpoint: str,
        api_key: str,
        model_name: str = "text-embedding-3-small",
        timeout: int = 30,
        max_retries: int = 3,
        batch_size: int = 100
    ):
        """
        初始化远程 Embedder

        Args:
            api_endpoint: API 端点 (例如: https://api.openai.com/v1)
            api_key: API 密钥
            model_name: 模型名称
            timeout: 请求超时时间（秒）
            max_retries: 最大重试次数
            batch_size: 批处理大小（单次请求最多文本数）
        """
        self.api_endpoint = api_endpoint.rstrip("/")
        self.api_key = api_key
        self.model_name = model_name
        self.timeout = timeout
        self.max_retries = max_retries
        self.batch_size = batch_size

        # 缓存向量维度
        self._embedding_dim: Optional[int] = None

        logger.info(f"✅ 远程 Embedder 已初始化")
        logger.info(f"   API: {self.api_endpoint}")
        logger.info(f"   模型: {self.model_name}")

    def embed(self, texts: Union[str, List[str]]) -> List[List[float]]:
        """文本向量化"""
        # 统一处理为列表
        if isinstance(texts, str):
            texts = [texts]
            single_text = True
        else:
            single_text = False

        if not texts:
            return []

        # 批处理（避免单次请求过大）
        all_embeddings = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i:i + self.batch_size]
            logger.info(f"处理第 {i // self.batch_size + 1} 批，共 {len(batch)} 条文本")

            embeddings = self._embed_batch(batch)

            # 验证批次结果
            if not embeddings:
                raise RuntimeError(f"批次 {i // self.batch_size + 1} 返回空结果")

            if len(embeddings) != len(batch):
                raise RuntimeError(
                    f"批次 {i // self.batch_size + 1} 返回的向量数量 ({len(embeddings)}) "
                    f"与输入文本数量 ({len(batch)}) 不匹配"
                )

            all_embeddings.extend(embeddings)

        # 如果输入是单个文本，返回单个向量
        if single_text:
            return [all_embeddings[0]]

        return all_embeddings

    def _embed_batch(self, texts: List[str]) -> List[List[float]]:
        """批量向量化（单次 API 调用）"""
        url = f"{self.api_endpoint}/embeddings"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": self.model_name,
            "input": texts,
            "encoding_format": "float"  # 明确指定编码格式 (ModelScope 等 API 需要)
        }

        for attempt in range(self.max_retries):
            try:
                response = requests.post(
                    url,
                    json=payload,
                    headers=headers,
                    timeout=self.timeout
                )

                # 详细的错误信息
                if not response.ok:
                    error_detail = ""
                    try:
                        error_data = response.json()
                        error_detail = f"\n响应内容: {error_data}"
                    except:
                        error_detail = f"\n响应文本: {response.text[:500]}"

                    logger.error(
                        f"Embedding API 请求失败 (尝试 {attempt + 1}/{self.max_retries}):\n"
                        f"URL: {url}\n"
                        f"状态码: {response.status_code}"
                        f"{error_detail}"
                    )

                response.raise_for_status()

                # 解析响应数据
                data = response.json()

                # 调试日志：记录响应结构
                logger.debug(f"Embedding API 响应结构: {list(data.keys()) if data else 'None'}")

                # 验证响应数据结构
                if not data:
                    raise ValueError("API 返回空响应")

                if "data" not in data:
                    logger.error(f"API 响应缺少 'data' 字段，完整响应: {data}")
                    raise ValueError(f"API 响应格式错误: 缺少 'data' 字段。响应内容: {data}")

                if not data["data"]:
                    raise ValueError(f"API 返回的 'data' 字段为空: {data}")

                # 提取 embeddings
                embeddings = [item["embedding"] for item in data["data"]]

                # 缓存向量维度
                if self._embedding_dim is None and embeddings:
                    self._embedding_dim = len(embeddings[0])
                    logger.info(f"向量维度: {self._embedding_dim}")

                return embeddings

            except (requests.exceptions.RequestException, ValueError, KeyError) as e:
                logger.warning(f"Embedding API 调用失败 (尝试 {attempt + 1}/{self.max_retries}): {e}")

                if attempt == self.max_retries - 1:
                    logger.error(
                        f"Embedding API 调用失败，已达最大重试次数\n"
                        f"请检查:\n"
                        f"1. API 端点: {self.api_endpoint}\n"
                        f"2. API Key 是否有效\n"
                        f"3. 模型名称: {self.model_name}\n"
                        f"4. 网络连接是否正常\n"
                        f"5. API 响应格式是否正确"
                    )
                    raise

        # 如果所有重试都失败，抛出异常而不是返回空列表
        raise RuntimeError(f"Embedding API 调用失败，已重试 {self.max_retries} 次")

    @property
    def embedding_dim(self) -> int:
        """获取向量维度"""
        if self._embedding_dim is None:
            # 通过一个测试文本获取维度
            test_embedding = self.embed("test")
            if test_embedding:
                self._embedding_dim = len(test_embedding[0])
            else:
                raise RuntimeError("无法获取向量维度")

        return self._embedding_dim


class TextEmbedder:
    """
    统一的 Embedder 接口（单例模式）

    根据配置自动选择合适的 Embedder 实现
    """

    _instance: Optional['TextEmbedder'] = None
    _embedder: Optional[EmbedderBase] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        logger.info("TextEmbedder 已创建（延迟初始化）")

    def initialize(self, config=None):
        """
        初始化 Embedder

        Args:
            config: AppConfig 配置对象
        """
        if self._embedder is not None:
            logger.debug("Embedder 已初始化，跳过重复初始化")
            return

        # 加载配置
        if config is None:
            from config import get_config
            config = get_config()

        mode = config.embedding.mode.lower()

        if mode == "remote":
            # 使用远程 API
            self._embedder = RemoteEmbedder(
                api_endpoint=config.embedding.remote.api_endpoint,
                api_key=config.embedding.remote.api_key,
                model_name=config.embedding.remote.model_name,
                timeout=config.embedding.remote.timeout,
                max_retries=config.embedding.remote.max_retries,
                batch_size=config.embedding.remote.batch_size
            )
        else:
            raise ValueError(
                f"不支持的 embedding 模式: {mode}\n"
                f"目前仅支持 'remote' 模式（使用远程 API）\n"
                f"请在 config.yaml 中配置:\n"
                f"embedding:\n"
                f"  mode: remote\n"
                f"  remote:\n"
                f"    api_endpoint: https://api.openai.com/v1\n"
                f"    api_key: your_api_key\n"
                f"    model_name: text-embedding-3-small"
            )

        logger.info(f"✅ Embedder 初始化完成 (模式: {mode})")

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

        return self._embedder.embed(texts)

    @property
    def embedding_dim(self) -> int:
        """获取向量维度"""
        if self._embedder is None:
            self.initialize()

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
