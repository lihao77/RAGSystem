#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""远程 Embedding API 客户端 - 支持 OpenAI 兼容接口"""

import logging
import requests
from typing import List, Union
import numpy as np

logger = logging.getLogger(__name__)


class RemoteEmbedder:
    """远程 Embedding API 客户端
    
    支持 OpenAI 兼容的 Embedding API，包括：
    - OpenAI API
    - 自建 Embedding 服务
    - 其他兼容接口
    """
    
    def __init__(
        self,
        api_endpoint: str,
        api_key: str,
        model_name: str = "text-embedding-3-small",
        timeout: int = 30,
        max_retries: int = 3
    ):
        """初始化远程 Embedding 客户端
        
        Args:
            api_endpoint: API 端点地址，例如 https://api.openai.com/v1
            api_key: API 密钥
            model_name: 模型名称
            timeout: 请求超时时间（秒）
            max_retries: 最大重试次数
        """
        self.api_endpoint = api_endpoint.rstrip('/')
        self.api_key = api_key
        self.model_name = model_name
        self.timeout = timeout
        self.max_retries = max_retries
        
        # 构建完整的 embeddings 端点
        self.embeddings_url = f"{self.api_endpoint}/embeddings"
        
        logger.info(f"初始化远程 Embedding 客户端")
        logger.info(f"  API 端点: {self.api_endpoint}")
        logger.info(f"  模型: {self.model_name}")
    
    def encode(
        self,
        texts: Union[str, List[str]],
        batch_size: int = 32,
        show_progress_bar: bool = False,
        **kwargs
    ) -> np.ndarray:
        """编码文本为向量
        
        Args:
            texts: 单个文本或文本列表
            batch_size: 批处理大小
            show_progress_bar: 是否显示进度条（兼容参数，API 调用不显示）
            **kwargs: 其他兼容参数
        
        Returns:
            numpy 数组，形状为 (n_texts, embedding_dim)
        """
        # 统一处理为列表
        if isinstance(texts, str):
            texts = [texts]
            single_text = True
        else:
            single_text = False
        
        # 分批处理
        all_embeddings = []
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            batch_embeddings = self._encode_batch(batch)
            all_embeddings.extend(batch_embeddings)
        
        # 转换为 numpy 数组
        embeddings = np.array(all_embeddings)
        
        # 如果输入是单个文本，返回一维数组
        if single_text:
            return embeddings[0]
        
        return embeddings
    
    def _encode_batch(self, texts: List[str]) -> List[List[float]]:
        """编码一批文本
        
        Args:
            texts: 文本列表
        
        Returns:
            嵌入向量列表
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "input": texts,
            "model": self.model_name
        }
        
        # 重试逻辑
        for attempt in range(self.max_retries):
            try:
                response = requests.post(
                    self.embeddings_url,
                    headers=headers,
                    json=payload,
                    timeout=self.timeout
                )
                response.raise_for_status()
                
                # 解析响应
                data = response.json()
                embeddings = [item["embedding"] for item in data["data"]]
                
                return embeddings
                
            except requests.exceptions.Timeout:
                if attempt < self.max_retries - 1:
                    logger.warning(f"请求超时，重试 {attempt + 1}/{self.max_retries}")
                    continue
                else:
                    raise Exception(f"请求超时，已重试 {self.max_retries} 次")
            
            except requests.exceptions.RequestException as e:
                if attempt < self.max_retries - 1:
                    logger.warning(f"请求失败: {e}，重试 {attempt + 1}/{self.max_retries}")
                    continue
                else:
                    raise Exception(f"请求失败: {e}")
            
            except (KeyError, ValueError) as e:
                raise Exception(f"响应格式错误: {e}, 响应内容: {response.text}")
    
    def get_sentence_embedding_dimension(self) -> int:
        """获取嵌入向量维度
        
        通过实际调用一次 API 来获取维度
        
        Returns:
            向量维度
        """
        try:
            test_embedding = self.encode("test")
            return len(test_embedding)
        except Exception as e:
            logger.error(f"无法获取向量维度: {e}")
            # 返回常见维度作为默认值
            if "text-embedding-3-small" in self.model_name:
                return 1536
            elif "text-embedding-3-large" in self.model_name:
                return 3072
            elif "text-embedding-ada-002" in self.model_name:
                return 1536
            else:
                # 默认维度
                return 1536


def create_remote_embedder_from_config(config) -> RemoteEmbedder:
    """从配置创建远程 Embedder
    
    Args:
        config: 配置对象，包含 embedding.remote 配置
    
    Returns:
        RemoteEmbedder 实例
    """
    remote_config = config.embedding.remote
    
    if not remote_config.api_endpoint:
        raise ValueError("远程 Embedding API 端点未配置")
    
    if not remote_config.api_key:
        raise ValueError("远程 Embedding API 密钥未配置")
    
    return RemoteEmbedder(
        api_endpoint=remote_config.api_endpoint,
        api_key=remote_config.api_key,
        model_name=remote_config.model_name,
        timeout=remote_config.timeout,
        max_retries=remote_config.max_retries
    )
