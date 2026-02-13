# -*- coding: utf-8 -*-
"""
Embedding 模型管理器

管理多个 embedding 模型的注册、激活、查询等操作。
"""

import sqlite3
import logging
from typing import List, Dict, Any, Optional
from dataclasses import dataclass
from datetime import datetime

logger = logging.getLogger(__name__)


@dataclass
class EmbeddingModelInfo:
    """Embedding 模型信息"""
    id: int
    model_key: str              # 唯一标识
    provider: str               # openai, deepseek, etc.
    model_name: str             # text-embedding-3-small
    vector_dimension: int       # 768, 1536, etc.
    distance_metric: str        # cosine, l2, ip
    is_active: bool             # 是否激活
    api_endpoint: Optional[str]
    created_at: datetime
    last_used_at: datetime
    vectorizer_key: Optional[str] = None  # 向量化器键，与 VectorizerConfigStore 对应


class EmbeddingModelManager:
    """Embedding 模型管理器"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_tables()

    def _init_tables(self):
        """初始化模型管理表"""
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS embedding_models (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                model_key TEXT UNIQUE NOT NULL,
                provider TEXT NOT NULL,
                model_name TEXT NOT NULL,
                vector_dimension INTEGER NOT NULL,
                distance_metric TEXT NOT NULL,
                is_active BOOLEAN DEFAULT 0,
                api_endpoint TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # 唯一激活约束
        self.conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_active_model
            ON embedding_models(is_active) WHERE is_active = 1
        """)
        
        # 关联表：存储向量
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS document_vectors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id TEXT NOT NULL,
                collection TEXT NOT NULL,
                model_id INTEGER NOT NULL,
                embedding BLOB NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (doc_id, collection) REFERENCES documents(id, collection) ON DELETE CASCADE,
                FOREIGN KEY (model_id) REFERENCES embedding_models(id) ON DELETE CASCADE,
                UNIQUE(doc_id, collection, model_id)
            )
        """)
        
        # 索引
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_doc_vectors_doc ON document_vectors(doc_id, collection)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_doc_vectors_model ON document_vectors(model_id)")
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_doc_vectors_collection ON document_vectors(collection)")
        
        # 尝试添加 documents 表的新字段（如果不存在）
        try:
            self.conn.execute("ALTER TABLE documents ADD COLUMN vector_sync_status TEXT DEFAULT '{}'")
        except sqlite3.OperationalError:
            pass  # 字段已存在
            
        try:
            self.conn.execute("ALTER TABLE documents ADD COLUMN last_vector_sync TIMESTAMP")
        except sqlite3.OperationalError:
            pass  # 字段已存在

        try:
            self.conn.execute("ALTER TABLE embedding_models ADD COLUMN vectorizer_key TEXT")
        except sqlite3.OperationalError:
            pass  # 字段已存在

        self.conn.commit()

    def register_model(
        self,
        provider: str,
        model_name: str,
        vector_dimension: int,
        distance_metric: str = "cosine",
        api_endpoint: Optional[str] = None,
        set_active: bool = False,
        vectorizer_key: Optional[str] = None
    ) -> int:
        """
        注册一个新的 embedding 模型。

        vectorizer_key: 与 VectorizerConfigStore 中的键一致，用于可观测与 API 展示。
        """
        model_key = f"{provider}_{model_name}_{vector_dimension}"

        # 若存在 vectorizer_key 则优先按 vectorizer_key 查
        if vectorizer_key:
            cursor = self.conn.execute(
                "SELECT id FROM embedding_models WHERE vectorizer_key = ?",
                (vectorizer_key,)
            )
            existing = cursor.fetchone()
        else:
            existing = None
        if not existing:
            cursor = self.conn.execute(
                "SELECT id FROM embedding_models WHERE model_key = ?",
                (model_key,)
            )
            existing = cursor.fetchone()

        if existing:
            model_id = existing['id']
            logger.info(f"模型已存在: {model_key} (ID: {model_id})")
            if vectorizer_key:
                self.conn.execute(
                    "UPDATE embedding_models SET vectorizer_key = ? WHERE id = ?",
                    (vectorizer_key, model_id)
                )
                self.conn.commit()
            if set_active:
                self.set_active_model(model_id)
            return model_id

        # 插入新模型
        cursor = self.conn.execute(
            """
            INSERT INTO embedding_models
                (model_key, provider, model_name, vector_dimension, distance_metric, api_endpoint, is_active, vectorizer_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (model_key, provider, model_name, vector_dimension, distance_metric, api_endpoint, set_active, vectorizer_key)
        )

        model_id = cursor.lastrowid
        self.conn.commit()

        logger.info(f"✓ 注册新模型: {model_key} (ID: {model_id}, 激活: {set_active})")
        
        # 如果是第一个模型，且没有设置激活，则默认激活
        if not set_active:
             count = self.conn.execute("SELECT COUNT(*) FROM embedding_models").fetchone()[0]
             if count == 1:
                 self.set_active_model(model_id)

        return model_id

    def get_active_model(self) -> Optional[EmbeddingModelInfo]:
        """获取当前激活的模型"""
        cursor = self.conn.execute(
            "SELECT * FROM embedding_models WHERE is_active = 1"
        )
        row = cursor.fetchone()

        if row is None:
            return None

        return self._row_to_model_info(row)

    def set_active_model(self, model_id: int) -> None:
        """设置激活模型（自动取消其他模型的激活状态）"""
        with self.conn:
            # 取消所有激活状态
            self.conn.execute("UPDATE embedding_models SET is_active = 0")

            # 激活指定模型
            self.conn.execute(
                """
                UPDATE embedding_models
                SET is_active = 1, last_used_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (model_id,)
            )

        logger.info(f"✓ 已激活模型 ID: {model_id}")

    def list_models(self) -> List[EmbeddingModelInfo]:
        """列出所有模型"""
        cursor = self.conn.execute(
            "SELECT * FROM embedding_models ORDER BY created_at DESC"
        )
        return [self._row_to_model_info(row) for row in cursor.fetchall()]

    def get_model_by_id(self, model_id: int) -> Optional[EmbeddingModelInfo]:
        """根据 ID 获取模型"""
        cursor = self.conn.execute(
            "SELECT * FROM embedding_models WHERE id = ?",
            (model_id,)
        )
        row = cursor.fetchone()
        return self._row_to_model_info(row) if row else None

    def get_model_by_vectorizer_key(self, vectorizer_key: str) -> Optional[EmbeddingModelInfo]:
        """根据向量化器键获取模型（用于插件式向量库管理）"""
        cursor = self.conn.execute(
            "SELECT * FROM embedding_models WHERE vectorizer_key = ?",
            (vectorizer_key,)
        )
        row = cursor.fetchone()
        return self._row_to_model_info(row) if row else None

    def delete_model(self, model_id: int, force: bool = False) -> bool:
        """
        删除模型（需要先删除关联的向量数据）

        Args:
            model_id: 模型 ID
            force: 是否强制删除（忽略激活状态）

        Returns:
            是否成功删除
        """
        model = self.get_model_by_id(model_id)

        if model is None:
            logger.warning(f"模型不存在: ID={model_id}")
            return False

        if model.is_active and not force:
            logger.error(f"无法删除激活模型: {model.model_key}，请先切换到其他模型")
            return False

        # 删除关联的向量数据（由外键级联删除，但为了保险手动删除）
        with self.conn:
            self.conn.execute(
                "DELETE FROM document_vectors WHERE model_id = ?",
                (model_id,)
            )

            self.conn.execute(
                "DELETE FROM embedding_models WHERE id = ?",
                (model_id,)
            )

        logger.info(f"✓ 已删除模型: {model.model_key}")
        return True

    def get_model_stats(self, model_id: int, collection: str = None) -> Dict[str, Any]:
        """
        获取模型的向量统计信息

        Returns:
            {
                "model_id": 1,
                "model_key": "openai_text-embedding-3-small_1536",
                "vector_count": 12345,
                "storage_size_mb": 45.6,
                "collections": {"default": 12000, "docs": 345}
            }
        """
        model = self.get_model_by_id(model_id)
        if model is None:
            return {}

        # 统计向量数量
        if collection:
            cursor = self.conn.execute(
                """
                SELECT COUNT(*) as count
                FROM document_vectors
                WHERE model_id = ? AND collection = ?
                """,
                (model_id, collection)
            )
        else:
            cursor = self.conn.execute(
                "SELECT COUNT(*) as count FROM document_vectors WHERE model_id = ?",
                (model_id,)
            )

        vector_count = cursor.fetchone()['count']

        # 估算存储大小 (向量维度 * 4 bytes * 数量)
        storage_size_mb = (model.vector_dimension * 4 * vector_count) / (1024 * 1024)

        # 按集合统计
        cursor = self.conn.execute(
            """
            SELECT collection, COUNT(*) as count
            FROM document_vectors
            WHERE model_id = ?
            GROUP BY collection
            """,
            (model_id,)
        )
        collections_stats = {row['collection']: row['count'] for row in cursor.fetchall()}

        return {
            "model_id": model_id,
            "model_key": model.model_key,
            "provider": model.provider,
            "model_name": model.model_name,
            "vector_dimension": model.vector_dimension,
            "is_active": model.is_active,
            "vector_count": vector_count,
            "storage_size_mb": round(storage_size_mb, 2),
            "collections": collections_stats
        }

    def _row_to_model_info(self, row: sqlite3.Row) -> EmbeddingModelInfo:
        """将数据库行转换为 EmbeddingModelInfo"""
        return EmbeddingModelInfo(
            id=row['id'],
            model_key=row['model_key'],
            provider=row['provider'],
            model_name=row['model_name'],
            vector_dimension=row['vector_dimension'],
            distance_metric=row['distance_metric'],
            is_active=bool(row['is_active']),
            api_endpoint=row['api_endpoint'],
            created_at=datetime.fromisoformat(row['created_at']) if isinstance(row['created_at'], str) else row['created_at'],
            last_used_at=datetime.fromisoformat(row['last_used_at']) if isinstance(row['last_used_at'], str) else row['last_used_at'],
            vectorizer_key=row['vectorizer_key'] if 'vectorizer_key' in row.keys() and row['vectorizer_key'] else None,
        )

    def close(self):
        """关闭数据库连接"""
        self.conn.close()
