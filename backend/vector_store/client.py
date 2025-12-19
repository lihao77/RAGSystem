# -*- coding: utf-8 -*-
"""
ChromaDB客户端封装

提供向量数据库的连接管理和集合操作
"""

import chromadb
from chromadb.config import Settings
from pathlib import Path
from typing import Optional, Dict, Any
import logging

logger = logging.getLogger(__name__)


class VectorStoreClient:
    """向量数据库客户端（单例模式）"""
    
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        # 数据持久化目录
        persist_dir = Path(__file__).parent.parent / "data" / "vector_store"
        persist_dir.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"初始化向量数据库，存储路径: {persist_dir}")
        
        # 创建ChromaDB客户端
        self.client = chromadb.PersistentClient(
            path=str(persist_dir),
            settings=Settings(
                anonymized_telemetry=False,  # 禁用匿名遥测
                allow_reset=True
            )
        )
        
        self._initialized = True
        logger.info("向量数据库客户端初始化完成")
    
    def get_or_create_collection(
        self, 
        name: str, 
        metadata: Optional[Dict[str, Any]] = None
    ):
        """
        获取或创建集合
        
        Args:
            name: 集合名称
            metadata: 集合元数据
        
        Returns:
            Collection对象
        """
        try:
            collection = self.client.get_or_create_collection(
                name=name,
                metadata=metadata or {"description": "向量集合"}
            )
            logger.info(f"集合已就绪: {name}")
            return collection
        except Exception as e:
            logger.error(f"创建集合失败: {name}, 错误: {e}")
            raise
    
    def get_collection(self, name: str):
        """
        获取已存在的集合
        
        Args:
            name: 集合名称
        
        Returns:
            Collection对象
        
        Raises:
            ValueError: 集合不存在
        """
        try:
            return self.client.get_collection(name)
        except Exception as e:
            raise ValueError(f"集合不存在: {name}") from e
    
    def list_collections(self):
        """
        列出所有集合
        
        Returns:
            集合列表
        """
        return self.client.list_collections()
    
    def delete_collection(self, name: str):
        """
        删除集合
        
        Args:
            name: 集合名称
        """
        try:
            self.client.delete_collection(name)
            logger.info(f"集合已删除: {name}")
        except Exception as e:
            logger.error(f"删除集合失败: {name}, 错误: {e}")
            raise
    
    def reset(self):
        """重置数据库（清空所有数据，慎用）"""
        logger.warning("⚠️ 重置向量数据库，所有数据将被清空")
        self.client.reset()


# 全局单例
_vector_client = None


def get_vector_client() -> VectorStoreClient:
    """
    获取向量数据库客户端单例
    
    Returns:
        VectorStoreClient实例
    """
    global _vector_client
    if _vector_client is None:
        _vector_client = VectorStoreClient()
    return _vector_client
