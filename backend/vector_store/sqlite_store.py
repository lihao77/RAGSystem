# -*- coding: utf-8 -*-
"""
SQLite + sqlite-vec 向量存储实现

使用 SQLite 作为向量数据库，通过 sqlite-vec 扩展支持高效的向量检索。

特性:
- 零依赖部署（单文件数据库）
- SQL 原生支持（强大的元数据过滤）
- 支持 HNSW 索引（与 ChromaDB 相同算法）
- 易于迁移到 PostgreSQL + pgvector

依赖:
- pip install sqlite-vec
"""

import sqlite3
import json
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional
from contextlib import contextmanager

from .base import VectorStoreBase, Document, SearchResult

logger = logging.getLogger(__name__)


class SQLiteVectorStore(VectorStoreBase):
    """SQLite + sqlite-vec 向量存储实现"""

    def __init__(
        self,
        db_path: str,
        vector_dimension: int = 768,
        distance_metric: str = "cosine"
    ):
        """
        初始化 SQLite 向量存储

        Args:
            db_path: 数据库文件路径
            vector_dimension: 向量维度（默认 768，适配 bge-small-zh-v1.5）
            distance_metric: 距离度量
                - cosine: 余弦相似度（推荐，范围 0-2）
                - l2: 欧氏距离
                - ip: 内积（点积）
        """
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self.vector_dimension = vector_dimension
        self.distance_metric = distance_metric.lower()

        if self.distance_metric not in ["cosine", "l2", "ip"]:
            raise ValueError(f"不支持的距离度量: {distance_metric}")

        # 连接池（使用 check_same_thread=False 允许多线程）
        self.conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False
        )
        self.conn.row_factory = sqlite3.Row  # 返回字典格式

        # 加载 sqlite-vec 扩展
        self._load_vector_extension()

        logger.info(f"✅ SQLite 向量存储已初始化: {self.db_path}")
        logger.info(f"   向量维度: {vector_dimension}, 距离度量: {distance_metric}")

    def _load_vector_extension(self):
        """加载 sqlite-vec 扩展"""
        try:
            self.conn.enable_load_extension(True)

            # 尝试多种加载方式
            loaded = False

            # 方式1: 尝试直接加载 sqlite-vec 扩展
            try:
                import sqlite_vec
                # 获取扩展路径
                ext_path = sqlite_vec.loadable_path()
                if ext_path:
                    self.conn.load_extension(ext_path)
                    loaded = True
                    logger.info(f"✅ 已加载 sqlite-vec 扩展: {ext_path}")
            except Exception as e1:
                logger.warning(f"方式1加载失败: {e1}")

                # 方式2: 尝试使用 sqlite_vec.load() 辅助函数
                try:
                    import sqlite_vec
                    sqlite_vec.load(self.conn)
                    loaded = True
                    logger.info("✅ 通过 sqlite_vec.load() 加载扩展")
                except Exception as e2:
                    logger.warning(f"方式2加载失败: {e2}")

            # 验证扩展是否可用
            if loaded:
                try:
                    self.conn.execute("SELECT vec_version()").fetchone()
                    logger.info("✅ sqlite-vec 扩展验证成功")
                    return
                except sqlite3.OperationalError:
                    logger.warning("扩展加载但验证失败，尝试其他方式")

            # 如果以上方式都失败，抛出错误
            raise ImportError(
                "sqlite-vec 扩展不可用。\n"
                "请按以下步骤安装:\n"
                "1. pip install sqlite-vec\n"
                "2. 确保 Python 版本 >= 3.8\n"
                "3. 在 Windows 上，可能需要安装 Visual C++ Redistributable\n"
                "4. 或者尝试: pip install --upgrade --force-reinstall sqlite-vec"
            )

        except ImportError as e:
            logger.error(f"❌ sqlite-vec 模块未安装: {e}")
            raise
        except Exception as e:
            logger.error(f"❌ sqlite-vec 扩展加载失败: {e}")
            raise ImportError("sqlite-vec 扩展加载失败") from e

    def initialize(self) -> None:
        """初始化数据库表结构"""
        # 检查是否需要重建（维度不匹配）
        if self._check_dimension_mismatch():
            logger.warning("⚠️  检测到向量维度不匹配，将重建数据库表")
            self._rebuild_database()
            return

        # 创建集合表（类似 ChromaDB 的 collection 概念）
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS collections (
                name TEXT PRIMARY KEY,
                vector_dimension INTEGER NOT NULL,
                distance_metric TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                metadata TEXT  -- JSON
            )
        """)

        # 创建文档表
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT NOT NULL,
                collection TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,  -- JSON
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id, collection),
                FOREIGN KEY (collection) REFERENCES collections(name) ON DELETE CASCADE
            )
        """)

        # 创建向量表（使用 sqlite-vec 虚拟表）
        self.conn.execute(f"""
            CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(
                doc_id TEXT NOT NULL,
                collection TEXT NOT NULL,
                embedding FLOAT[{self.vector_dimension}] distance_metric={self.distance_metric}
            )
        """)

        # 创建索引加速查询
        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_documents_collection
            ON documents(collection)
        """)

        self.conn.commit()
        logger.info("✅ 数据库表结构初始化完成")

    def _check_dimension_mismatch(self) -> bool:
        """
        检查现有数据库的向量维度是否与配置不匹配

        Returns:
            True 表示需要重建，False 表示不需要
        """
        try:
            # 检查 collections 表是否存在
            cursor = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='collections'"
            )
            if cursor.fetchone() is None:
                # 表不存在，不需要重建
                return False

            # 检查是否有集合
            cursor = self.conn.execute("SELECT vector_dimension FROM collections LIMIT 1")
            row = cursor.fetchone()

            if row is None:
                # 没有数据，不需要重建
                return False

            existing_dimension = row[0]
            if existing_dimension != self.vector_dimension:
                logger.warning(
                    f"检测到维度不匹配:\n"
                    f"  现有数据库维度: {existing_dimension}\n"
                    f"  新配置维度: {self.vector_dimension}"
                )
                return True

            return False

        except Exception as e:
            logger.debug(f"检查维度时出错（可能是新数据库）: {e}")
            return False

    def _rebuild_database(self) -> None:
        """
        重建数据库（删除所有表并重新创建）

        警告：此操作会丢失所有现有数据！
        """
        logger.warning("⚠️  开始重建数据库，所有现有数据将被删除！")

        try:
            # 1. 备份现有数据（如果需要迁移）
            backup_data = self._backup_existing_data()

            # 2. 删除所有表
            self.conn.execute("DROP TABLE IF EXISTS vectors")
            self.conn.execute("DROP TABLE IF EXISTS documents")
            self.conn.execute("DROP TABLE IF EXISTS collections")
            self.conn.commit()
            logger.info("✓ 已删除旧表结构")

            # 3. 重新创建表（递归调用，但不会再次检测不匹配）
            self.conn.execute("""
                CREATE TABLE IF NOT EXISTS collections (
                    name TEXT PRIMARY KEY,
                    vector_dimension INTEGER NOT NULL,
                    distance_metric TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    metadata TEXT
                )
            """)

            self.conn.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT NOT NULL,
                    collection TEXT NOT NULL,
                    content TEXT NOT NULL,
                    metadata TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (id, collection),
                    FOREIGN KEY (collection) REFERENCES collections(name) ON DELETE CASCADE
                )
            """)

            self.conn.execute(f"""
                CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(
                    doc_id TEXT NOT NULL,
                    collection TEXT NOT NULL,
                    embedding FLOAT[{self.vector_dimension}] distance_metric={self.distance_metric}
                )
            """)

            self.conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_documents_collection
                ON documents(collection)
            """)

            self.conn.commit()
            logger.info("✓ 新表结构创建完成")

            # 4. 提示用户数据已丢失
            if backup_data:
                logger.warning(
                    f"⚠️  数据库已重建，原有 {len(backup_data)} 条文档已丢失\n"
                    f"   如需保留数据，请使用数据迁移工具重新编码"
                )
            else:
                logger.info("✓ 数据库重建完成（原数据库为空）")

        except Exception as e:
            logger.error(f"❌ 数据库重建失败: {e}")
            raise

    def _backup_existing_data(self) -> list:
        """
        备份现有数据（仅内容和元数据，不包括向量）

        Returns:
            文档列表 [{id, collection, content, metadata}, ...]
        """
        try:
            cursor = self.conn.execute(
                "SELECT id, collection, content, metadata FROM documents"
            )
            rows = cursor.fetchall()

            backup = []
            for row in rows:
                backup.append({
                    "id": row[0],
                    "collection": row[1],
                    "content": row[2],
                    "metadata": row[3]
                })

            if backup:
                logger.info(f"✓ 已备份 {len(backup)} 条文档（仅内容，不含向量）")

            return backup

        except Exception as e:
            logger.debug(f"备份数据时出错: {e}")
            return []

    @contextmanager
    def _transaction(self):
        """事务上下文管理器"""
        try:
            yield self.conn
            self.conn.commit()
        except Exception as e:
            self.conn.rollback()
            logger.error(f"事务回滚: {e}")
            raise

    def _ensure_collection_exists(self, collection: str):
        """确保集合存在"""
        cursor = self.conn.execute(
            "SELECT name FROM collections WHERE name = ?",
            (collection,)
        )
        if cursor.fetchone() is None:
            # 创建新集合
            self.conn.execute(
                """
                INSERT INTO collections (name, vector_dimension, distance_metric, metadata)
                VALUES (?, ?, ?, ?)
                """,
                (collection, self.vector_dimension, self.distance_metric, "{}")
            )
            self.conn.commit()
            logger.info(f"创建新集合: {collection}")

    def add_documents(
        self,
        documents: List[Document],
        collection: str = "default"
    ) -> None:
        """添加文档到向量存储"""
        if not documents:
            return

        self._ensure_collection_exists(collection)

        with self._transaction():
            for doc in documents:
                if doc.embedding is None:
                    raise ValueError(f"文档 {doc.id} 缺少 embedding")

                if len(doc.embedding) != self.vector_dimension:
                    raise ValueError(
                        f"向量维度不匹配: 期望 {self.vector_dimension}, "
                        f"实际 {len(doc.embedding)}"
                    )

                # 插入或更新文档
                self.conn.execute(
                    """
                    INSERT OR REPLACE INTO documents (id, collection, content, metadata, updated_at)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    """,
                    (doc.id, collection, doc.content, json.dumps(doc.metadata, ensure_ascii=False))
                )

                # 删除旧向量（如果存在）
                self.conn.execute(
                    "DELETE FROM vectors WHERE doc_id = ? AND collection = ?",
                    (doc.id, collection)
                )

                # 插入新向量
                embedding_blob = self._serialize_vector(doc.embedding)
                self.conn.execute(
                    "INSERT INTO vectors (doc_id, collection, embedding) VALUES (?, ?, ?)",
                    (doc.id, collection, embedding_blob)
                )

        logger.info(f"添加了 {len(documents)} 个文档到集合 '{collection}'")

    def search(
        self,
        query_embedding: List[float],
        top_k: int = 10,
        collection: str = "default",
        filters: Optional[Dict[str, Any]] = None
    ) -> List[SearchResult]:
        """向量相似度检索"""
        if len(query_embedding) != self.vector_dimension:
            raise ValueError(
                f"查询向量维度不匹配: 期望 {self.vector_dimension}, "
                f"实际 {len(query_embedding)}"
            )

        # 构建 SQL 查询
        query_blob = self._serialize_vector(query_embedding)

        # 基础查询（使用 sqlite-vec 的相似度搜索）
        # 注意：distance 是通过 vec_distance 函数计算的，不是列
        sql = """
            SELECT
                d.id,
                d.content,
                d.metadata,
                vec_distance_{}(v.embedding, ?) as distance
            FROM vectors v
            JOIN documents d ON v.doc_id = d.id AND v.collection = d.collection
            WHERE v.collection = ?
        """.format(self.distance_metric)

        params = [query_blob, collection]

        # 添加元数据过滤
        if filters:
            for key, value in filters.items():
                sql += f" AND json_extract(d.metadata, '$.{key}') = ?"
                params.append(value)

        # 排序 + 限制（distance 已在 SELECT 中计算）
        sql += """
            ORDER BY distance ASC
            LIMIT ?
        """

        params.append(top_k)

        cursor = self.conn.execute(sql, params)
        rows = cursor.fetchall()

        # 转换为 SearchResult
        results = []
        for row in rows:
            distance = row["distance"]
            # 转换距离为相似度分数 (0-1, 越高越相似)
            score = self._distance_to_score(distance)

            results.append(SearchResult(
                id=row["id"],
                content=row["content"],
                metadata=json.loads(row["metadata"]),
                score=score,
                distance=distance
            ))

        return results

    def get_document(
        self,
        doc_id: str,
        collection: str = "default"
    ) -> Optional[Document]:
        """根据 ID 获取文档"""
        cursor = self.conn.execute(
            """
            SELECT id, content, metadata
            FROM documents
            WHERE id = ? AND collection = ?
            """,
            (doc_id, collection)
        )
        row = cursor.fetchone()

        if row is None:
            return None

        # 获取向量
        cursor = self.conn.execute(
            "SELECT embedding FROM vectors WHERE doc_id = ? AND collection = ?",
            (doc_id, collection)
        )
        vec_row = cursor.fetchone()
        embedding = self._deserialize_vector(vec_row["embedding"]) if vec_row else None

        return Document(
            id=row["id"],
            content=row["content"],
            metadata=json.loads(row["metadata"]),
            embedding=embedding
        )

    def delete_documents(
        self,
        doc_ids: List[str],
        collection: str = "default"
    ) -> int:
        """删除文档"""
        if not doc_ids:
            return 0

        with self._transaction():
            # 删除文档（会级联删除向量）
            placeholders = ",".join("?" * len(doc_ids))
            cursor = self.conn.execute(
                f"""
                DELETE FROM documents
                WHERE id IN ({placeholders}) AND collection = ?
                """,
                (*doc_ids, collection)
            )
            deleted_count = cursor.rowcount

            # 删除对应的向量
            self.conn.execute(
                f"""
                DELETE FROM vectors
                WHERE doc_id IN ({placeholders}) AND collection = ?
                """,
                (*doc_ids, collection)
            )

        logger.info(f"从集合 '{collection}' 删除了 {deleted_count} 个文档")
        return deleted_count

    def list_collections(self) -> List[str]:
        """列出所有集合"""
        cursor = self.conn.execute("SELECT name FROM collections ORDER BY name")
        return [row["name"] for row in cursor.fetchall()]

    def delete_collection(self, collection: str) -> None:
        """删除集合"""
        with self._transaction():
            # 删除向量
            self.conn.execute(
                "DELETE FROM vectors WHERE collection = ?",
                (collection,)
            )
            # 删除文档
            self.conn.execute(
                "DELETE FROM documents WHERE collection = ?",
                (collection,)
            )
            # 删除集合
            self.conn.execute(
                "DELETE FROM collections WHERE name = ?",
                (collection,)
            )

        logger.info(f"集合 '{collection}' 已删除")

    def count_documents(self, collection: str = "default") -> int:
        """统计文档数量"""
        cursor = self.conn.execute(
            "SELECT COUNT(*) as count FROM documents WHERE collection = ?",
            (collection,)
        )
        return cursor.fetchone()["count"]

    def get_collection_info(self, collection: str = "default") -> Dict[str, Any]:
        """获取集合信息"""
        cursor = self.conn.execute(
            """
            SELECT name, vector_dimension, distance_metric, created_at, metadata
            FROM collections
            WHERE name = ?
            """,
            (collection,)
        )
        row = cursor.fetchone()

        if row is None:
            raise ValueError(f"集合不存在: {collection}")

        doc_count = self.count_documents(collection)

        return {
            "name": row["name"],
            "vector_dimension": row["vector_dimension"],
            "distance_metric": row["distance_metric"],
            "document_count": doc_count,
            "created_at": row["created_at"],
            "metadata": json.loads(row["metadata"])
        }

    def close(self) -> None:
        """关闭数据库连接"""
        if self.conn:
            self.conn.close()
            logger.info("SQLite 连接已关闭")

    # ========== 辅助方法 ==========

    def _serialize_vector(self, vector: List[float]) -> bytes:
        """将向量序列化为 blob（sqlite-vec 需要）"""
        import struct
        return struct.pack(f"{len(vector)}f", *vector)

    def _deserialize_vector(self, blob: bytes) -> List[float]:
        """将 blob 反序列化为向量"""
        import struct
        count = len(blob) // 4
        return list(struct.unpack(f"{count}f", blob))

    def _distance_to_score(self, distance: float) -> float:
        """
        将距离转换为相似度分数 (0-1)

        cosine: 0 (相同) - 2 (相反) → 1 (相同) - 0 (相反)
        l2: 0 (相同) - ∞ (不同) → 1 (相同) - 0 (不同)
        ip: -∞ - ∞ → 归一化到 0-1
        """
        if self.distance_metric == "cosine":
            # cosine distance = 1 - cosine similarity
            # distance 范围 [0, 2], 转换为 similarity [1, -1], 再归一化到 [1, 0]
            return max(0.0, 1.0 - distance / 2.0)
        elif self.distance_metric == "l2":
            # 简单的指数衰减
            return 1.0 / (1.0 + distance)
        elif self.distance_metric == "ip":
            # 内积越大越相似（需根据实际情况调整）
            return 1.0 / (1.0 + abs(distance))
        else:
            return 0.0

    def __enter__(self):
        """上下文管理器支持"""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """上下文管理器支持"""
        self.close()
