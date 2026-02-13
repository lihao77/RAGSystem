# -*- coding: utf-8 -*-
"""
向量存储客户端 - 工厂模式

根据配置自动创建合适的向量存储后端:
- SQLiteVectorStore: SQLite + sqlite-vec (默认推荐)
- PostgreSQLVectorStore: PostgreSQL + pgvector (未来扩展)
"""

import logging
from pathlib import Path
from typing import Optional

from .base import VectorStoreBase
from .sqlite_store import SQLiteVectorStore

logger = logging.getLogger(__name__)


class VectorStoreClient:
    """向量存储客户端（单例模式，工厂模式）"""

    _instance: Optional['VectorStoreClient'] = None
    _store: Optional[VectorStoreBase] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        logger.info("向量存储客户端已创建（延迟初始化）")

    def reset(self):
        """重置已创建的存储实例，使下次 initialize 时按当前配置重新初始化（用于配置热重载）。"""
        if self._store is not None:
            try:
                self._store.close()
            except Exception:
                pass
        self._store = None
        logger.debug("向量存储客户端已重置，下次使用将按当前配置重新初始化")

    def initialize(self, config=None, force=False):
        """
        初始化向量存储

        Args:
            config: AppConfig 配置对象
            force: 为 True 时先重置再初始化（用于配置变更后）
        """
        if force:
            self.reset()
        if self._store is not None:
            logger.debug("向量存储已初始化，跳过重复初始化")
            return

        # 加载配置
        if config is None:
            from config import get_config
            config = get_config()

        backend = config.vector_store.backend.lower()

        if backend == "sqlite_vec":
            self._init_sqlite_store(config.vector_store.sqlite_vec)
        elif backend == "postgresql":
            self._init_postgresql_store(config.vector_store.postgresql)
        else:
            raise ValueError(
                f"不支持的向量存储后端: {backend}\n"
                f"支持的后端: sqlite_vec, postgresql"
            )

        # 初始化数据库表结构
        self._store.initialize()

        logger.info(f"✅ 向量存储初始化完成 (后端: {backend})")

    def _init_sqlite_store(self, config):
        """初始化 SQLite 向量存储"""
        # 确保路径是绝对路径
        db_path = Path(config.database_path)
        if not db_path.is_absolute():
            # 相对于 backend/ 目录
            db_path = Path(__file__).parent.parent / db_path

        logger.info(f"初始化 SQLite 向量存储: {db_path}")

        # 智能推断向量维度：优先从 Embedder 获取实际维度
        vector_dimension = self._get_vector_dimension(config.vector_dimension)

        self._store = SQLiteVectorStore(
            db_path=str(db_path),
            vector_dimension=vector_dimension,
            distance_metric=config.distance_metric
        )

    def _get_vector_dimension(self, config_dimension: int) -> int:
        """
        智能获取向量维度

        优先级：
        1. 从 Embedder 获取实际维度（按当前激活向量化器初始化后再取）
        2. 使用配置文件中的维度（config_dimension=0 表示未配置，仅用 Embedder）

        Args:
            config_dimension: 配置文件中的维度，0 表示未配置、自动与当前模型一致

        Returns:
            实际使用的向量维度
        """
        try:
            from .embedder import get_embedder
            embedder = get_embedder()
            # 先按当前激活向量化器初始化，避免存储用默认 768 而激活模型为 1536 等不一致
            embedder.initialize()

            if embedder._embedder is not None:
                actual_dimension = embedder.embedding_dim

                # 未配置维度(0)：静默使用 Embedder 维度，不告警
                if config_dimension == 0:
                    logger.info(f"使用 Embedder 向量维度: {actual_dimension}")
                    return actual_dimension

                # 已配置但与 Embedder 不一致：告警并采用 Embedder
                if actual_dimension != config_dimension:
                    logger.warning(
                        f"⚠️  配置的向量维度 ({config_dimension}) 与 Embedder 实际维度 ({actual_dimension}) 不匹配\n"
                        f"   将自动使用 Embedder 的实际维度: {actual_dimension}"
                    )
                    return actual_dimension

                logger.info(f"✓ 向量维度匹配: {actual_dimension}")
                return actual_dimension
        except Exception as e:
            logger.debug(f"无法从 Embedder 获取维度，使用配置值: {e}")

        # 无 Embedder 时：配置为 0 则退回到通用默认 768，否则用配置值
        if config_dimension == 0:
            logger.info("未配置向量维度且 Embedder 未就绪，使用默认维度: 768")
            return 768
        logger.info(f"使用配置的向量维度: {config_dimension}")
        return config_dimension

    def _init_postgresql_store(self, config):
        """初始化 PostgreSQL 向量存储（未来实现）"""
        raise NotImplementedError(
            "PostgreSQL + pgvector 后端尚未实现\n"
            "请使用 sqlite_vec 后端，或等待未来版本更新"
        )

    def ensure_initialized(self):
        """确保已初始化"""
        if self._store is None:
            self.initialize()

    @property
    def store(self) -> VectorStoreBase:
        """获取向量存储实例"""
        self.ensure_initialized()
        return self._store

    # ========== 代理方法（转发到底层存储） ==========

    def add_documents(self, documents, collection="default"):
        """添加文档"""
        return self.store.add_documents(documents, collection)

    def search(self, query_embedding, top_k=10, collection="default", filters=None):
        """向量检索"""
        return self.store.search(query_embedding, top_k, collection, filters)

    def get_document(self, doc_id, collection="default"):
        """获取文档"""
        return self.store.get_document(doc_id, collection)

    def delete_documents(self, doc_ids, collection="default"):
        """删除文档"""
        return self.store.delete_documents(doc_ids, collection)

    def list_collections(self):
        """列出集合"""
        return self.store.list_collections()

    def delete_collection(self, collection):
        """删除集合"""
        return self.store.delete_collection(collection)

    def count_documents(self, collection="default"):
        """统计文档数量"""
        return self.store.count_documents(collection)

    def get_collection_info(self, collection="default"):
        """获取集合信息"""
        return self.store.get_collection_info(collection)

    def close(self):
        """关闭连接"""
        if self._store:
            self._store.close()


# 全局单例
_vector_client: Optional[VectorStoreClient] = None


def reset_vector_client():
    """重置全局向量存储客户端，使配置重载后下次使用按新配置初始化。"""
    client = get_vector_client()
    client.reset()


def get_vector_client() -> VectorStoreClient:
    """
    获取向量存储客户端单例

    Returns:
        VectorStoreClient 实例
    """
    global _vector_client
    if _vector_client is None:
        _vector_client = VectorStoreClient()
    return _vector_client
