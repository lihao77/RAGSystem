# -*- coding: utf-8 -*-
"""
文件索引 SQLite 存储实现

使用 SQLite 替代 YAML 文件存储，提供：
- 事务支持（原子性写入）
- 高效查询（索引、过滤、排序）
- 并发安全
- 扩展性（可添加标签、索引状态等字段）
"""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
from contextlib import contextmanager
import logging

logger = logging.getLogger(__name__)


class FileIndexSQLite:
    """
    基于 SQLite 的文件索引存储

    表结构:
    - uploaded_files: 文件元数据
    """

    def __init__(self, db_path: str | Path | None = None):
        """
        初始化 SQLite 文件索引

        Args:
            db_path: 数据库文件路径
                    默认使用统一的数据库: backend/data/ragsystem.db
                    这样可以与向量数据库共享连接，便于跨表查询
        """
        if db_path is None:
            # 默认使用统一的数据库路径（与向量存储共享）
            backend_dir = Path(__file__).parent.parent
            db_path = backend_dir / "data" / "ragsystem.db"

        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        # 初始化数据库
        self._init_database()

        logger.info(f"FileIndexSQLite 初始化完成: {self.db_path}")

    def _init_database(self):
        """创建数据库表结构"""
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS uploaded_files (
                    id TEXT PRIMARY KEY,
                    original_name TEXT NOT NULL,
                    stored_name TEXT NOT NULL,
                    stored_path TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    mime TEXT,
                    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    uploaded_by TEXT,
                    indexed_in_vector BOOLEAN DEFAULT FALSE,
                    tags TEXT,
                    notes TEXT
                )
            """)

            # 创建索引
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_uploaded_at
                ON uploaded_files(uploaded_at)
            """)

            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_mime
                ON uploaded_files(mime)
            """)

            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_indexed
                ON uploaded_files(indexed_in_vector)
            """)

            conn.commit()
            logger.info("数据库表结构初始化完成")

    @contextmanager
    def _get_connection(self):
        """获取数据库连接（上下文管理器）"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row  # 返回字典式行
        try:
            yield conn
        finally:
            conn.close()

    def list(
        self,
        limit: int = 100,
        offset: int = 0,
        mime_filter: Optional[str] = None,
        indexed_only: Optional[bool] = None,
        search_term: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        列出文件

        Args:
            limit: 返回数量限制
            offset: 偏移量（分页）
            mime_filter: MIME 类型过滤
            indexed_only: 只返回已索引的文件
            search_term: 搜索词（匹配文件名）

        Returns:
            文件记录列表
        """
        with self._get_connection() as conn:
            query = "SELECT * FROM uploaded_files WHERE 1=1"
            params = []

            # 添加过滤条件
            if mime_filter:
                query += " AND mime = ?"
                params.append(mime_filter)

            if indexed_only is not None:
                query += " AND indexed_in_vector = ?"
                params.append(1 if indexed_only else 0)

            if search_term:
                query += " AND original_name LIKE ?"
                params.append(f"%{search_term}%")

            # 排序和分页
            query += " ORDER BY uploaded_at DESC LIMIT ? OFFSET ?"
            params.extend([limit, offset])

            cursor = conn.execute(query, params)
            rows = cursor.fetchall()

            return [self._row_to_dict(row) for row in rows]

    def count(
        self,
        mime_filter: Optional[str] = None,
        indexed_only: Optional[bool] = None
    ) -> int:
        """
        统计文件数量

        Args:
            mime_filter: MIME 类型过滤
            indexed_only: 只统计已索引的文件

        Returns:
            文件数量
        """
        with self._get_connection() as conn:
            query = "SELECT COUNT(*) as count FROM uploaded_files WHERE 1=1"
            params = []

            if mime_filter:
                query += " AND mime = ?"
                params.append(mime_filter)

            if indexed_only is not None:
                query += " AND indexed_in_vector = ?"
                params.append(1 if indexed_only else 0)

            cursor = conn.execute(query, params)
            return cursor.fetchone()["count"]

    def get(self, file_id: str) -> Optional[Dict[str, Any]]:
        """
        获取单个文件记录

        Args:
            file_id: 文件ID

        Returns:
            文件记录，不存在返回 None
        """
        with self._get_connection() as conn:
            cursor = conn.execute(
                "SELECT * FROM uploaded_files WHERE id = ?",
                (file_id,)
            )
            row = cursor.fetchone()
            return self._row_to_dict(row) if row else None

    def add(
        self,
        *,
        original_name: str,
        stored_name: str,
        stored_path: str,
        size: int = 0,
        mime: str = "",
        uploaded_by: Optional[str] = None,
        tags: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        添加文件记录

        Args:
            original_name: 原始文件名
            stored_name: 存储文件名
            stored_path: 存储路径
            size: 文件大小（字节）
            mime: MIME 类型
            uploaded_by: 上传用户
            tags: 标签（逗号分隔）

        Returns:
            完整的文件记录
        """
        file_id = str(uuid.uuid4())[:10]
        now = datetime.now().isoformat()

        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO uploaded_files
                (id, original_name, stored_name, stored_path, size, mime,
                 uploaded_at, uploaded_by, indexed_in_vector, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (file_id, original_name, stored_name, stored_path, size, mime,
                 now, uploaded_by, False, tags)
            )
            conn.commit()

        logger.info(f"文件记录已添加: {file_id} - {original_name}")
        return self.get(file_id)

    def update(
        self,
        file_id: str,
        *,
        indexed_in_vector: Optional[bool] = None,
        tags: Optional[str] = None,
        notes: Optional[str] = None
    ) -> bool:
        """
        更新文件记录

        Args:
            file_id: 文件ID
            indexed_in_vector: 是否已索引到向量库
            tags: 标签
            notes: 备注

        Returns:
            是否成功更新
        """
        updates = []
        params = []

        if indexed_in_vector is not None:
            updates.append("indexed_in_vector = ?")
            params.append(1 if indexed_in_vector else 0)

        if tags is not None:
            updates.append("tags = ?")
            params.append(tags)

        if notes is not None:
            updates.append("notes = ?")
            params.append(notes)

        if not updates:
            return True  # 没有要更新的字段

        params.append(file_id)

        with self._get_connection() as conn:
            cursor = conn.execute(
                f"UPDATE uploaded_files SET {', '.join(updates)} WHERE id = ?",
                params
            )
            conn.commit()
            success = cursor.rowcount > 0

        if success:
            logger.info(f"文件记录已更新: {file_id}")
        else:
            logger.warning(f"文件记录不存在: {file_id}")

        return success

    def delete(self, file_id: str) -> bool:
        """
        删除文件记录

        Args:
            file_id: 文件ID

        Returns:
            是否成功删除
        """
        with self._get_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM uploaded_files WHERE id = ?",
                (file_id,)
            )
            conn.commit()
            success = cursor.rowcount > 0

        if success:
            logger.info(f"文件记录已删除: {file_id}")
        else:
            logger.warning(f"文件记录不存在: {file_id}")

        return success

    def mark_indexed(self, file_id: str) -> bool:
        """
        标记文件已索引到向量库

        Args:
            file_id: 文件ID

        Returns:
            是否成功标记
        """
        return self.update(file_id, indexed_in_vector=True)

    def _row_to_dict(self, row: sqlite3.Row) -> Dict[str, Any]:
        """将数据库行转换为字典"""
        return {
            "id": row["id"],
            "original_name": row["original_name"],
            "stored_name": row["stored_name"],
            "stored_path": row["stored_path"],
            "size": row["size"],
            "mime": row["mime"],
            "uploaded_at": row["uploaded_at"],
            "uploaded_by": row["uploaded_by"],
            "indexed_in_vector": bool(row["indexed_in_vector"]),
            "tags": row["tags"],
            "notes": row["notes"]
        }
