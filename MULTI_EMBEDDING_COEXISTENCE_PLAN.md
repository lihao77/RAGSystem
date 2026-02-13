# 多 Embedding 模型共存改进计划

## 📋 项目概述

**目标**：将现有的"替换式"向量迁移机制升级为"共存式"多模型架构，支持多个 embedding 模型的向量数据同时存在，用户可灵活切换和管理。

**核心理念**：
- ✅ 增量添加，而非删除重建
- ✅ 多模型向量共存
- ✅ 用户手动控制同步和删除
- ✅ 零数据丢失风险

---

## 🎯 核心需求

| 需求 | 说明 | 优先级 |
|-----|------|-------|
| **多模型存储** | 同一文档可拥有多个不同模型生成的向量 | P0 |
| **激活状态管理** | 用户选择当前查询使用哪个模型的向量 | P0 |
| **手动同步** | 更换模型后，用户在管理界面手动触发向量生成 | P0 |
| **增量同步** | 只为缺少该模型向量的文档生成向量 | P0 |
| **选择性删除** | 用户可删除非激活模型的向量数据 | P1 |
| **空间统计** | 显示每个模型向量占用的存储空间 | P1 |
| **自动清理** | 删除文档时自动清理所有模型的关联向量 | P0 |

---

## 🏗️ 架构设计

### 1. 数据库结构重构

#### 1.1 新增 `embedding_models` 表

记录系统中所有使用过的 embedding 模型。

```sql
CREATE TABLE embedding_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_key TEXT UNIQUE NOT NULL,           -- 唯一标识: provider_model_dimension
    provider TEXT NOT NULL,                   -- API 提供商: openai, deepseek, etc.
    model_name TEXT NOT NULL,                 -- 模型名称: text-embedding-3-small
    vector_dimension INTEGER NOT NULL,        -- 向量维度: 768, 1536, etc.
    distance_metric TEXT NOT NULL,            -- 距离度量: cosine, l2, ip
    is_active BOOLEAN DEFAULT 0,              -- 是否为当前激活模型
    api_endpoint TEXT,                        -- API 端点
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 确保只有一个激活模型
CREATE UNIQUE INDEX idx_active_model ON embedding_models(is_active) WHERE is_active = 1;

-- 示例数据
INSERT INTO embedding_models (model_key, provider, model_name, vector_dimension, distance_metric, is_active, api_endpoint)
VALUES
    ('openai_text-embedding-3-small_1536', 'openai', 'text-embedding-3-small', 1536, 'cosine', 1, 'https://api.openai.com/v1'),
    ('deepseek_deepseek-embedding_1024', 'deepseek', 'deepseek-embedding', 1024, 'cosine', 0, 'https://api.deepseek.com/v1');
```

#### 1.2 修改 `collections` 表

移除硬编码的 `vector_dimension`，改为引用 `embedding_models`。

```sql
-- 删除旧字段（迁移时处理）
-- ALTER TABLE collections DROP COLUMN vector_dimension;
-- ALTER TABLE collections DROP COLUMN distance_metric;

-- 新结构
CREATE TABLE collections_v2 (
    name TEXT PRIMARY KEY,
    description TEXT,                         -- 集合描述
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT                             -- JSON 扩展字段
);
```

#### 1.3 重构 `vectors` 表

支持同一文档的多模型向量。

```sql
-- 删除旧的虚拟表
DROP TABLE IF EXISTS vectors;

-- 为每个模型创建独立的虚拟表
-- 动态创建，格式: vectors_{model_id}
CREATE VIRTUAL TABLE vectors_1 USING vec0(
    doc_id TEXT NOT NULL,
    collection TEXT NOT NULL,
    embedding FLOAT[1536] distance_metric=cosine
);

CREATE VIRTUAL TABLE vectors_2 USING vec0(
    doc_id TEXT NOT NULL,
    collection TEXT NOT NULL,
    embedding FLOAT[1024] distance_metric=cosine
);

-- 创建索引加速查询
CREATE INDEX IF NOT EXISTS idx_vectors_1_doc ON vectors_1(doc_id, collection);
CREATE INDEX IF NOT EXISTS idx_vectors_2_doc ON vectors_2(doc_id, collection);
```

**或者使用关联表方案（推荐）**：

```sql
-- 方案2：使用关联表（更灵活）
CREATE TABLE document_vectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    collection TEXT NOT NULL,
    model_id INTEGER NOT NULL,                -- 关联到 embedding_models.id
    embedding BLOB NOT NULL,                  -- 序列化后的向量
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (doc_id, collection) REFERENCES documents(id, collection) ON DELETE CASCADE,
    FOREIGN KEY (model_id) REFERENCES embedding_models(id) ON DELETE CASCADE,
    UNIQUE(doc_id, collection, model_id)      -- 同一文档+集合+模型唯一
);

CREATE INDEX idx_doc_vectors_doc ON document_vectors(doc_id, collection);
CREATE INDEX idx_doc_vectors_model ON document_vectors(model_id);
CREATE INDEX idx_doc_vectors_collection ON document_vectors(collection);
```

> **⚠️ 技术决策**：由于 `sqlite-vec` 虚拟表不支持外键，推荐使用 **方案2（关联表）**，但搜索时需要先过滤 `model_id` 再进行向量检索。

#### 1.4 修改 `documents` 表

添加向量同步状态跟踪。

```sql
ALTER TABLE documents ADD COLUMN vector_sync_status TEXT DEFAULT '{}';  -- JSON: {"model_1": "synced", "model_2": "pending"}
ALTER TABLE documents ADD COLUMN last_vector_sync TIMESTAMP;
```

---

### 2. 后端核心逻辑

#### 2.1 Embedding 模型管理器

**新增文件**：`backend/vector_store/model_manager.py`

```python
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

        self.conn.commit()

    def register_model(
        self,
        provider: str,
        model_name: str,
        vector_dimension: int,
        distance_metric: str = "cosine",
        api_endpoint: Optional[str] = None,
        set_active: bool = False
    ) -> int:
        """
        注册一个新的 embedding 模型

        Returns:
            模型 ID
        """
        model_key = f"{provider}_{model_name}_{vector_dimension}"

        # 检查是否已存在
        cursor = self.conn.execute(
            "SELECT id FROM embedding_models WHERE model_key = ?",
            (model_key,)
        )
        existing = cursor.fetchone()

        if existing:
            model_id = existing['id']
            logger.info(f"模型已存在: {model_key} (ID: {model_id})")

            # 如果需要激活
            if set_active:
                self.set_active_model(model_id)

            return model_id

        # 插入新模型
        cursor = self.conn.execute(
            """
            INSERT INTO embedding_models
                (model_key, provider, model_name, vector_dimension, distance_metric, api_endpoint, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (model_key, provider, model_name, vector_dimension, distance_metric, api_endpoint, set_active)
        )

        model_id = cursor.lastrowid
        self.conn.commit()

        logger.info(f"✓ 注册新模型: {model_key} (ID: {model_id}, 激活: {set_active})")

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

        # 删除关联的向量数据（由外键级联删除）
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
            created_at=datetime.fromisoformat(row['created_at']),
            last_used_at=datetime.fromisoformat(row['last_used_at'])
        )

    def close(self):
        """关闭数据库连接"""
        self.conn.close()
```

#### 2.2 向量同步管理器

**新增文件**：`backend/vector_store/sync_manager.py`

```python
# -*- coding: utf-8 -*-
"""
向量同步管理器

负责增量同步向量数据到不同的 embedding 模型。
"""

import logging
import json
from typing import List, Dict, Any, Optional
from tqdm import tqdm

from .model_manager import EmbeddingModelManager, EmbeddingModelInfo
from .embedder import get_embedder
from .base import Document

logger = logging.getLogger(__name__)


class VectorSyncManager:
    """向量同步管理器"""

    def __init__(self, db_path: str, model_manager: EmbeddingModelManager):
        self.db_path = db_path
        self.model_manager = model_manager
        self.embedder = get_embedder()

    def get_unsync_documents(
        self,
        model_id: int,
        collection: str = "default",
        limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        获取尚未为指定模型生成向量的文档

        Args:
            model_id: 模型 ID
            collection: 集合名称
            limit: 最多返回数量（None 表示全部）

        Returns:
            文档列表 [{"id": "doc1", "content": "...", "metadata": {}}, ...]
        """
        import sqlite3
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row

        # 查询缺少该模型向量的文档
        query = """
            SELECT d.id, d.content, d.metadata
            FROM documents d
            WHERE d.collection = ?
              AND NOT EXISTS (
                  SELECT 1 FROM document_vectors dv
                  WHERE dv.doc_id = d.id
                    AND dv.collection = d.collection
                    AND dv.model_id = ?
              )
        """

        params = [collection, model_id]

        if limit:
            query += " LIMIT ?"
            params.append(limit)

        cursor = conn.execute(query, params)
        rows = cursor.fetchall()

        documents = []
        for row in rows:
            documents.append({
                "id": row['id'],
                "content": row['content'],
                "metadata": json.loads(row['metadata']) if row['metadata'] else {}
            })

        conn.close()

        logger.info(f"找到 {len(documents)} 个文档需要同步到模型 {model_id}")
        return documents

    def sync_documents_to_model(
        self,
        model_id: int,
        collection: str = "default",
        batch_size: int = 50,
        limit: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        将文档同步到指定模型（增量）

        Args:
            model_id: 目标模型 ID
            collection: 集合名称
            batch_size: 批处理大小
            limit: 最多同步数量

        Returns:
            同步结果统计
        """
        # 1. 获取模型信息
        model_info = self.model_manager.get_model_by_id(model_id)
        if model_info is None:
            raise ValueError(f"模型不存在: ID={model_id}")

        logger.info(f"开始同步到模型: {model_info.model_key}")

        # 2. 获取待同步文档
        unsync_docs = self.get_unsync_documents(model_id, collection, limit)

        if not unsync_docs:
            logger.info("✓ 没有需要同步的文档")
            return {
                "model_id": model_id,
                "model_key": model_info.model_key,
                "collection": collection,
                "total_documents": 0,
                "synced_count": 0,
                "failed_count": 0,
                "skipped_count": 0
            }

        # 3. 切换 Embedder 配置（如果需要）
        # TODO: 这里需要根据 model_info 动态配置 embedder

        # 4. 批量编码并存储
        synced_count = 0
        failed_count = 0

        import sqlite3
        conn = sqlite3.connect(self.db_path)

        for i in tqdm(range(0, len(unsync_docs), batch_size), desc=f"同步到 {model_info.model_key}"):
            batch = unsync_docs[i:i + batch_size]

            # 提取文本
            texts = [doc['content'] for doc in batch]

            try:
                # 批量编码
                embeddings = self.embedder.embed(texts)

                # 批量插入向量
                for doc, embedding in zip(batch, embeddings):
                    embedding_blob = self._serialize_vector(embedding)

                    conn.execute(
                        """
                        INSERT INTO document_vectors (doc_id, collection, model_id, embedding)
                        VALUES (?, ?, ?, ?)
                        """,
                        (doc['id'], collection, model_id, embedding_blob)
                    )

                conn.commit()
                synced_count += len(batch)

            except Exception as e:
                logger.error(f"批次同步失败: {e}")
                failed_count += len(batch)
                continue

        conn.close()

        logger.info(f"✓ 同步完成: 成功 {synced_count}，失败 {failed_count}")

        return {
            "model_id": model_id,
            "model_key": model_info.model_key,
            "collection": collection,
            "total_documents": len(unsync_docs),
            "synced_count": synced_count,
            "failed_count": failed_count,
            "skipped_count": 0
        }

    def sync_all_collections_to_model(
        self,
        model_id: int,
        batch_size: int = 50
    ) -> Dict[str, Any]:
        """
        同步所有集合到指定模型

        Returns:
            汇总统计
        """
        import sqlite3
        conn = sqlite3.connect(self.db_path)
        cursor = conn.execute("SELECT name FROM collections")
        collections = [row[0] for row in cursor.fetchall()]
        conn.close()

        total_synced = 0
        total_failed = 0
        results_by_collection = {}

        for collection_name in collections:
            result = self.sync_documents_to_model(model_id, collection_name, batch_size)
            total_synced += result['synced_count']
            total_failed += result['failed_count']
            results_by_collection[collection_name] = result

        return {
            "model_id": model_id,
            "total_synced": total_synced,
            "total_failed": total_failed,
            "collections": results_by_collection
        }

    def _serialize_vector(self, vector: List[float]) -> bytes:
        """序列化向量为 BLOB"""
        import struct
        return struct.pack(f"{len(vector)}f", *vector)
```

#### 2.3 修改 SQLiteVectorStore

**修改文件**：`backend/vector_store/sqlite_store.py`

```python
# 关键修改点

class SQLiteVectorStore(VectorStoreBase):
    def __init__(self, db_path: str, vector_dimension: int = 768, distance_metric: str = "cosine"):
        # ... 现有初始化代码 ...

        # 新增：模型管理器
        from .model_manager import EmbeddingModelManager
        self.model_manager = EmbeddingModelManager(str(self.db_path))

        # 自动注册当前配置的模型
        self._auto_register_current_model()

    def _auto_register_current_model(self):
        """自动注册当前配置的 embedding 模型"""
        from config import get_config
        config = get_config()

        from .embedder import get_embedder
        embedder = get_embedder()
        embedder.ensure_initialized()

        # 注册当前模型（如果不存在则创建）
        model_id = self.model_manager.register_model(
            provider=config.embedding.remote.api_endpoint.split('/')[2].split('.')[0],  # 简单推断
            model_name=config.embedding.remote.model_name,
            vector_dimension=embedder.embedding_dim,
            distance_metric=self.distance_metric,
            api_endpoint=config.embedding.remote.api_endpoint,
            set_active=True  # 默认激活
        )

        logger.info(f"✓ 当前模型已注册: ID={model_id}")

    def search(
        self,
        query_embedding: List[float],
        top_k: int = 10,
        collection: str = "default",
        filters: Optional[Dict[str, Any]] = None,
        model_id: Optional[int] = None  # 新增：指定使用哪个模型的向量
    ) -> List[SearchResult]:
        """向量相似度检索（支持多模型）"""

        # 如果未指定模型，使用激活模型
        if model_id is None:
            active_model = self.model_manager.get_active_model()
            if active_model is None:
                raise RuntimeError("没有激活的 embedding 模型")
            model_id = active_model.id

        # 后续检索逻辑改为从 document_vectors 表查询指定 model_id 的向量
        sql = """
            SELECT
                d.id,
                d.content,
                d.metadata,
                dv.embedding
            FROM document_vectors dv
            JOIN documents d ON dv.doc_id = d.id AND dv.collection = d.collection
            WHERE dv.collection = ? AND dv.model_id = ?
        """

        params = [collection, model_id]

        # 添加元数据过滤
        if filters:
            for key, value in filters.items():
                sql += f" AND json_extract(d.metadata, '$.{key}') = ?"
                params.append(value)

        cursor = self.conn.execute(sql, params)
        rows = cursor.fetchall()

        # 手动计算相似度并排序（因为不在虚拟表中）
        results = []
        for row in rows:
            embedding = self._deserialize_vector(row['embedding'])
            distance = self._calculate_distance(query_embedding, embedding)
            score = self._distance_to_score(distance)

            results.append(SearchResult(
                id=row['id'],
                content=row['content'],
                metadata=json.loads(row['metadata']),
                score=score,
                distance=distance
            ))

        # 排序并返回 top_k
        results.sort(key=lambda x: x.score, reverse=True)
        return results[:top_k]

    def _calculate_distance(self, vec1: List[float], vec2: List[float]) -> float:
        """计算向量距离"""
        import numpy as np

        if self.distance_metric == "cosine":
            # 余弦距离 = 1 - 余弦相似度
            return 1.0 - np.dot(vec1, vec2) / (np.linalg.norm(vec1) * np.linalg.norm(vec2))
        elif self.distance_metric == "l2":
            # 欧氏距离
            return np.linalg.norm(np.array(vec1) - np.array(vec2))
        elif self.distance_metric == "ip":
            # 内积（负值，因为越大越相似）
            return -np.dot(vec1, vec2)
        else:
            raise ValueError(f"不支持的距离度量: {self.distance_metric}")
```

---

### 3. API 端点设计

#### 3.1 模型管理 API

**新增文件**：`backend/routes/embedding_models.py`

```python
# -*- coding: utf-8 -*-
"""
Embedding 模型管理 API
"""

from flask import Blueprint, request, jsonify
from vector_store import get_vector_client
from vector_store.model_manager import EmbeddingModelManager
from vector_store.sync_manager import VectorSyncManager
import logging

logger = logging.getLogger(__name__)

embedding_models_bp = Blueprint('embedding_models', __name__)


@embedding_models_bp.route('/models', methods=['GET'])
def list_models():
    """列出所有 embedding 模型"""
    try:
        client = get_vector_client()
        model_manager = client.store.model_manager

        models = model_manager.list_models()

        # 获取每个模型的统计信息
        models_with_stats = []
        for model in models:
            stats = model_manager.get_model_stats(model.id)
            models_with_stats.append({
                "id": model.id,
                "model_key": model.model_key,
                "provider": model.provider,
                "model_name": model.model_name,
                "vector_dimension": model.vector_dimension,
                "distance_metric": model.distance_metric,
                "is_active": model.is_active,
                "api_endpoint": model.api_endpoint,
                "created_at": model.created_at.isoformat(),
                "last_used_at": model.last_used_at.isoformat(),
                "stats": stats
            })

        return jsonify({
            "success": True,
            "models": models_with_stats
        })

    except Exception as e:
        logger.error(f"获取模型列表失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@embedding_models_bp.route('/models/<int:model_id>/activate', methods=['POST'])
def activate_model(model_id: int):
    """激活指定模型"""
    try:
        client = get_vector_client()
        model_manager = client.store.model_manager

        model_manager.set_active_model(model_id)

        return jsonify({
            "success": True,
            "message": f"模型 {model_id} 已激活"
        })

    except Exception as e:
        logger.error(f"激活模型失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@embedding_models_bp.route('/models/<int:model_id>', methods=['DELETE'])
def delete_model(model_id: int):
    """删除指定模型（及其向量数据）"""
    try:
        force = request.args.get('force', 'false').lower() == 'true'

        client = get_vector_client()
        model_manager = client.store.model_manager

        success = model_manager.delete_model(model_id, force=force)

        if success:
            return jsonify({
                "success": True,
                "message": f"模型 {model_id} 已删除"
            })
        else:
            return jsonify({
                "success": False,
                "error": "删除失败，请检查日志"
            }), 400

    except Exception as e:
        logger.error(f"删除模型失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@embedding_models_bp.route('/models/<int:model_id>/sync', methods=['POST'])
def sync_model(model_id: int):
    """同步文档到指定模型（增量）"""
    try:
        data = request.get_json() or {}
        collection = data.get('collection', 'default')
        batch_size = data.get('batch_size', 50)
        limit = data.get('limit')  # 可选：限制同步数量

        client = get_vector_client()
        model_manager = client.store.model_manager

        sync_manager = VectorSyncManager(
            db_path=str(client.store.db_path),
            model_manager=model_manager
        )

        result = sync_manager.sync_documents_to_model(
            model_id=model_id,
            collection=collection,
            batch_size=batch_size,
            limit=limit
        )

        return jsonify({
            "success": True,
            "result": result
        })

    except Exception as e:
        logger.error(f"同步失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@embedding_models_bp.route('/models/<int:model_id>/stats', methods=['GET'])
def get_model_stats(model_id: int):
    """获取模型统计信息"""
    try:
        collection = request.args.get('collection')

        client = get_vector_client()
        model_manager = client.store.model_manager

        stats = model_manager.get_model_stats(model_id, collection)

        return jsonify({
            "success": True,
            "stats": stats
        })

    except Exception as e:
        logger.error(f"获取统计信息失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500


@embedding_models_bp.route('/models/sync-status', methods=['GET'])
def get_sync_status():
    """获取所有模型的同步状态"""
    try:
        collection = request.args.get('collection', 'default')

        client = get_vector_client()
        model_manager = client.store.model_manager
        sync_manager = VectorSyncManager(
            db_path=str(client.store.db_path),
            model_manager=model_manager
        )

        models = model_manager.list_models()
        sync_status = []

        for model in models:
            unsync_docs = sync_manager.get_unsync_documents(model.id, collection)
            total_docs = client.count_documents(collection)
            synced_docs = total_docs - len(unsync_docs)

            sync_status.append({
                "model_id": model.id,
                "model_key": model.model_key,
                "is_active": model.is_active,
                "total_documents": total_docs,
                "synced_documents": synced_docs,
                "pending_documents": len(unsync_docs),
                "sync_percentage": round(synced_docs / total_docs * 100, 2) if total_docs > 0 else 0
            })

        return jsonify({
            "success": True,
            "collection": collection,
            "sync_status": sync_status
        })

    except Exception as e:
        logger.error(f"获取同步状态失败: {e}", exc_info=True)
        return jsonify({"success": False, "error": str(e)}), 500
```

**注册蓝图**：在 `backend/app.py` 中添加

```python
from routes.embedding_models import embedding_models_bp
app.register_blueprint(embedding_models_bp, url_prefix='/api/embedding-models')
```

---

### 4. 前端管理界面

#### 4.1 Embedding 模型管理页面

**新增文件**：`frontend/src/views/EmbeddingModelsView.vue`

```vue
<template>
  <div class="embedding-models-view">
    <el-card class="header-card">
      <div class="header">
        <h2>Embedding 模型管理</h2>
        <el-button type="primary" @click="refreshData">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
      </div>
    </el-card>

    <!-- 模型列表 -->
    <el-card class="models-card">
      <template #header>
        <div class="card-header">
          <span>已注册模型</span>
          <el-tag v-if="activeModel" type="success">
            当前激活: {{ activeModel.model_name }}
          </el-tag>
        </div>
      </template>

      <el-table :data="models" style="width: 100%" v-loading="loading">
        <el-table-column prop="id" label="ID" width="60" />

        <el-table-column label="模型" min-width="200">
          <template #default="{ row }">
            <div class="model-info">
              <div class="model-name">{{ row.model_name }}</div>
              <div class="model-key">{{ row.model_key }}</div>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="provider" label="提供商" width="120" />

        <el-table-column prop="vector_dimension" label="向量维度" width="100" />

        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.is_active" type="success">激活</el-tag>
            <el-tag v-else type="info">未激活</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="向量数据" width="150">
          <template #default="{ row }">
            <div class="stats">
              <div>{{ row.stats.vector_count }} 个向量</div>
              <div class="storage-size">{{ row.stats.storage_size_mb }} MB</div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="同步状态" width="150">
          <template #default="{ row }">
            <div v-if="syncStatus[row.id]">
              <el-progress
                :percentage="syncStatus[row.id].sync_percentage"
                :status="syncStatus[row.id].sync_percentage === 100 ? 'success' : ''"
              />
              <div class="sync-info">
                {{ syncStatus[row.id].synced_documents }} / {{ syncStatus[row.id].total_documents }}
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button-group>
              <el-button
                v-if="!row.is_active"
                size="small"
                type="primary"
                @click="activateModel(row.id)"
              >
                激活
              </el-button>

              <el-button
                size="small"
                type="success"
                :disabled="syncStatus[row.id]?.sync_percentage === 100"
                @click="syncModel(row.id)"
              >
                <el-icon><Upload /></el-icon>
                同步
              </el-button>

              <el-button
                v-if="!row.is_active"
                size="small"
                type="danger"
                @click="confirmDelete(row)"
              >
                <el-icon><Delete /></el-icon>
                删除
              </el-button>
            </el-button-group>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 同步对话框 -->
    <el-dialog
      v-model="syncDialogVisible"
      title="同步向量数据"
      width="500px"
    >
      <el-form :model="syncForm" label-width="120px">
        <el-form-item label="目标模型">
          <el-input v-model="syncForm.modelName" disabled />
        </el-form-item>

        <el-form-item label="集合">
          <el-select v-model="syncForm.collection" style="width: 100%">
            <el-option
              v-for="coll in collections"
              :key="coll"
              :label="coll"
              :value="coll"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="批处理大小">
          <el-input-number v-model="syncForm.batchSize" :min="10" :max="500" />
        </el-form-item>

        <el-form-item label="限制数量">
          <el-input-number
            v-model="syncForm.limit"
            :min="0"
            placeholder="0 表示全部"
          />
        </el-form-item>
      </el-form>

      <div v-if="syncProgress.running" class="sync-progress">
        <el-progress :percentage="syncProgress.percentage" />
        <p>{{ syncProgress.message }}</p>
      </div>

      <template #footer>
        <el-button @click="syncDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          @click="startSync"
          :loading="syncProgress.running"
        >
          开始同步
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Upload, Delete } from '@element-plus/icons-vue'
import axios from 'axios'

const API_BASE = 'http://localhost:5000/api'

// 数据
const models = ref([])
const syncStatus = ref({})
const collections = ref(['default'])
const loading = ref(false)

// 计算属性
const activeModel = computed(() => models.value.find(m => m.is_active))

// 同步对话框
const syncDialogVisible = ref(false)
const syncForm = ref({
  modelId: null,
  modelName: '',
  collection: 'default',
  batchSize: 50,
  limit: 0
})

const syncProgress = ref({
  running: false,
  percentage: 0,
  message: ''
})

// 方法
const refreshData = async () => {
  loading.value = true
  try {
    // 获取模型列表
    const modelsRes = await axios.get(`${API_BASE}/embedding-models/models`)
    models.value = modelsRes.data.models

    // 获取同步状态
    const syncRes = await axios.get(`${API_BASE}/embedding-models/models/sync-status`)
    syncStatus.value = {}
    syncRes.data.sync_status.forEach(status => {
      syncStatus.value[status.model_id] = status
    })

    ElMessage.success('数据已刷新')
  } catch (error) {
    ElMessage.error('获取数据失败: ' + error.message)
  } finally {
    loading.value = false
  }
}

const activateModel = async (modelId) => {
  try {
    await axios.post(`${API_BASE}/embedding-models/models/${modelId}/activate`)
    ElMessage.success('模型已激活')
    refreshData()
  } catch (error) {
    ElMessage.error('激活失败: ' + error.message)
  }
}

const syncModel = (modelId) => {
  const model = models.value.find(m => m.id === modelId)
  syncForm.value.modelId = modelId
  syncForm.value.modelName = model.model_name
  syncDialogVisible.value = true
}

const startSync = async () => {
  syncProgress.value.running = true
  syncProgress.value.percentage = 0
  syncProgress.value.message = '正在同步...'

  try {
    const res = await axios.post(
      `${API_BASE}/embedding-models/models/${syncForm.value.modelId}/sync`,
      {
        collection: syncForm.value.collection,
        batch_size: syncForm.value.batchSize,
        limit: syncForm.value.limit || undefined
      }
    )

    const result = res.data.result
    syncProgress.value.percentage = 100
    syncProgress.value.message = `同步完成！成功: ${result.synced_count}, 失败: ${result.failed_count}`

    setTimeout(() => {
      syncDialogVisible.value = false
      refreshData()
    }, 2000)

  } catch (error) {
    ElMessage.error('同步失败: ' + error.message)
    syncProgress.value.message = '同步失败: ' + error.message
  } finally {
    syncProgress.value.running = false
  }
}

const confirmDelete = async (model) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除模型 "${model.model_name}" 及其所有向量数据吗？此操作不可恢复！`,
      '警告',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning',
      }
    )

    await axios.delete(`${API_BASE}/embedding-models/models/${model.id}`)
    ElMessage.success('模型已删除')
    refreshData()

  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败: ' + error.message)
    }
  }
}

// 生命周期
onMounted(() => {
  refreshData()
})
</script>

<style scoped>
.embedding-models-view {
  padding: 20px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.models-card {
  margin-top: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.model-info {
  display: flex;
  flex-direction: column;
}

.model-name {
  font-weight: bold;
  margin-bottom: 4px;
}

.model-key {
  font-size: 12px;
  color: #999;
}

.stats {
  font-size: 12px;
}

.storage-size {
  color: #999;
  margin-top: 4px;
}

.sync-info {
  font-size: 12px;
  color: #666;
  margin-top: 4px;
}

.sync-progress {
  margin-top: 20px;
}
</style>
```

**添加路由**：在 `frontend/src/router/index.js` 中添加

```javascript
{
  path: '/embedding-models',
  name: 'EmbeddingModels',
  component: () => import('../views/EmbeddingModelsView.vue'),
  meta: { title: 'Embedding 模型管理' }
}
```

---

## 📅 实施计划

### Phase 1: 数据库结构迁移（3-4天）

**任务清单**：
- [ ] 创建数据库迁移脚本 `migrations/add_multi_embedding_support.sql`
- [ ] 实现 `EmbeddingModelManager` 类
- [ ] 实现 `document_vectors` 关联表
- [ ] 编写数据迁移工具（将现有向量迁移到新结构）
- [ ] 测试数据迁移的正确性

**关键文件**：
- `backend/vector_store/model_manager.py` (新建)
- `backend/migrations/add_multi_embedding_support.sql` (新建)
- `backend/utils/migrate_to_multi_embedding.py` (新建)

**风险**：
- 现有数据迁移失败 → 提供回滚机制
- 维度推断错误 → 严格验证

---

### Phase 2: 向量同步管理（2-3天）

**任务清单**：
- [ ] 实现 `VectorSyncManager` 类
- [ ] 实现增量同步逻辑
- [ ] 实现批量编码和存储
- [ ] 添加同步进度跟踪
- [ ] 测试大规模数据同步性能

**关键文件**：
- `backend/vector_store/sync_manager.py` (新建)
- `backend/vector_store/sqlite_store.py` (修改)

**风险**：
- 并发同步冲突 → 添加锁机制
- 内存占用过高 → 使用流式处理

---

### Phase 3: API 开发（1-2天）

**任务清单**：
- [ ] 实现模型管理 API（列表、激活、删除）
- [ ] 实现同步 API（增量同步、全量同步）
- [ ] 实现统计 API（向量数量、存储大小）
- [ ] 添加 API 文档
- [ ] 编写单元测试

**关键文件**：
- `backend/routes/embedding_models.py` (新建)
- `backend/app.py` (修改：注册蓝图)

---

### Phase 4: 前端开发（2-3天）

**任务清单**：
- [ ] 实现 Embedding 模型管理页面
- [ ] 实现同步进度显示
- [ ] 实现模型激活切换
- [ ] 实现模型删除确认
- [ ] 优化用户交互体验

**关键文件**：
- `frontend-client/src/views/EmbeddingModelsView.vue` (新建)
- `frontend-client/src/router/index.js` (修改)
- `frontend-client/src/api/embeddingModels.js` (新建)

---

### Phase 5: 集成测试与文档（1-2天）

**任务清单**：
- [ ] 端到端测试（添加文档 → 切换模型 → 同步 → 查询）
- [ ] 性能测试（10万+ 文档的同步速度）
- [ ] 编写用户文档（如何切换模型、如何同步）
- [ ] 更新 CLAUDE.md 和 README.md
- [ ] 录制操作演示视频

---

## 🔍 技术难点与解决方案

### 难点 1: sqlite-vec 虚拟表不支持外键

**问题**：`CREATE VIRTUAL TABLE ... USING vec0` 不支持外键约束。

**解决方案**：
- 使用 `document_vectors` 关联表存储向量（BLOB 格式）
- 查询时先从关联表过滤 `model_id`，再手动计算相似度
- 或者为每个模型动态创建虚拟表（`vectors_{model_id}`）

**推荐方案**：关联表 + 手动计算，牺牲少量性能换取灵活性。

---

### 难点 2: 动态切换 Embedder 配置

**问题**：不同模型需要不同的 API 配置（端点、密钥、模型名）。

**解决方案**：

1. 在 `embedding_models` 表存储每个模型的 API 配置
2. 同步时临时覆盖 Embedder 配置
3. 或者实例化独立的 Embedder 对象

```python
# VectorSyncManager.sync_documents_to_model() 中
model_info = self.model_manager.get_model_by_id(model_id)

# 临时创建 Embedder
from vector_store.embedder import RemoteEmbedder
temp_embedder = RemoteEmbedder(
    api_endpoint=model_info.api_endpoint,
    api_key="从配置读取或存储在 embedding_models 表",
    model_name=model_info.model_name
)

embeddings = temp_embedder.embed(texts)
```

---

### 难点 3: 大规模数据同步性能

**问题**：10万+ 文档的同步可能耗时数小时。

**优化方案**：
1. **批量编码**：单次 API 调用编码 100 个文本
2. **并发请求**：使用 `asyncio` 或 `ThreadPoolExecutor`
3. **断点续传**：记录同步进度，失败后可恢复
4. **后台任务**：使用 Celery 或 RQ 异步执行
5. **进度回调**：WebSocket 实时推送进度到前端

```python
# 后台任务示例（使用 threading）
import threading

def sync_in_background(model_id, collection):
    thread = threading.Thread(
        target=sync_manager.sync_documents_to_model,
        args=(model_id, collection)
    )
    thread.daemon = True
    thread.start()
    return thread

# API 返回任务 ID，前端轮询状态
```

---

## 📊 性能预估

### 同步速度估算

假设：
- Embedding API 延迟：50ms/请求
- 批量编码：100 个文本/请求
- 并发请求数：5

**单线程同步**：
- 10万文档 = 1000 批次
- 耗时：1000 * 50ms = 50 秒

**5并发同步**：
- 耗时：50 / 5 = 10 秒

### 存储空间估算

| 模型 | 维度 | 向量大小 | 10万文档占用 |
|-----|-----|---------|------------|
| text-embedding-3-small | 1536 | 6 KB | 600 MB |
| deepseek-embedding | 1024 | 4 KB | 400 MB |
| bge-large-zh | 768 | 3 KB | 300 MB |

**2个模型共存**：约 1 GB

---

## ⚠️ 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|-----|-----|------|---------|
| 数据迁移失败 | 高 | 中 | 自动备份 + 回滚脚本 |
| 并发同步冲突 | 中 | 中 | 添加分布式锁 |
| API 调用超限 | 中 | 低 | 限流 + 重试机制 |
| 前端性能下降 | 低 | 低 | 虚拟滚动 + 分页 |
| 存储空间不足 | 中 | 低 | 监控磁盘空间 + 清理策略 |

---

## 🎯 验收标准

### 功能验收

- [ ] 可以注册多个 embedding 模型
- [ ] 可以切换激活模型
- [ ] 可以增量同步文档到指定模型
- [ ] 可以查询时指定使用哪个模型的向量
- [ ] 可以删除非激活模型的向量数据
- [ ] 可以查看每个模型的存储统计
- [ ] 同步失败后可以重试

### 性能验收

- [ ] 10万文档同步时间 < 2 分钟（5并发）
- [ ] 查询响应时间 < 500ms（与单模型相同）
- [ ] 数据库大小增长合理（每增加1个模型约 +300-600MB）

### 安全验收

- [ ] 删除模型需要二次确认
- [ ] 无法删除激活模型
- [ ] 数据迁移前自动备份
- [ ] 同步失败不影响现有数据

---

## 📚 用户文档大纲

### 1. 快速开始

- 如何注册新模型
- 如何切换激活模型
- 如何同步向量数据

### 2. 使用场景

- 场景1：评估不同 embedding 模型的效果
- 场景2：从免费模型升级到付费模型
- 场景3：测试新模型而不影响生产数据

### 3. 最佳实践

- 何时同步向量数据
- 如何清理旧模型数据
- 如何监控存储空间

### 4. 故障排查

- 同步失败怎么办
- 查询结果异常怎么办
- 存储空间不足怎么办

---

## 📈 后续优化方向

### 短期（1-3个月）

1. **后台任务队列**：使用 Celery 异步同步
2. **WebSocket 进度推送**：实时显示同步进度
3. **模型性能对比**：A/B 测试不同模型的检索效果
4. **自动清理策略**：定期清理未使用的模型

### 中期（3-6个月）

1. **模型版本管理**：支持同一模型的多个版本
2. **混合检索**：同时使用多个模型的向量进行检索并融合结果
3. **增量更新**：文档更新时自动同步所有模型的向量
4. **成本监控**：统计每个模型的 API 调用成本

### 长期（6-12个月）

1. **分布式同步**：支持多机并行同步
2. **模型推荐**：根据数据特征自动推荐最佳模型
3. **向量压缩**：使用量化技术减少存储空间
4. **GPU 加速**：本地模型支持 GPU 推理

---

## 📝 总结

本改进计划将现有的"替换式"向量迁移升级为"共存式"多模型架构，核心优势：

✅ **零数据丢失**：新模型不会覆盖旧模型的向量
✅ **灵活切换**：随时切换不同模型进行检索
✅ **增量同步**：只为缺少向量的文档生成向量
✅ **用户可控**：所有操作由用户在管理界面手动触发
✅ **可扩展性**：轻松支持 10+ 个模型共存

**预计总工时**：10-14 天
**技术难度**：⭐⭐⭐⭐（中高难度）
**用户价值**：⭐⭐⭐⭐⭐（极高价值）

---

## 🤝 实施建议

建议分 3 个迭代实施：

**迭代 1（核心功能）**：Phase 1 + Phase 2
- 数据库结构迁移
- 向量同步管理
- 验收标准：可以手动调用 API 同步向量

**迭代 2（用户界面）**：Phase 3 + Phase 4
- API 开发
- 前端管理界面
- 验收标准：可以在界面上完成所有操作

**迭代 3（优化完善）**：Phase 5
- 性能优化
- 文档编写
- 验收标准：生产环境可用

---

**是否需要我开始实施？建议从 Phase 1（数据库结构迁移）开始。**
