import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from config import get_config
from utils.backup_database import backup_database as _backup_database
from utils.backup_database import restore_database as _restore_database


class ConversationStore:
    def __init__(
        self,
        db_path: Optional[str] = None,
        cleanup_interval_seconds: int = 300,
        session_ttl_days: int = 30,
        enable_archive: bool = True,
        start_cleanup_thread: bool = True
    ):
        if db_path is None:
            config = get_config()
            db_path = config.vector_store.sqlite_vec.database_path

        db_path = Path(db_path)
        if not db_path.is_absolute():
            db_path = Path(__file__).parent / db_path

        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self.cleanup_interval_seconds = cleanup_interval_seconds
        self.session_ttl_days = session_ttl_days
        self.enable_archive = enable_archive

        # ✨ 改进：使用 session 级别的锁，避免全局锁成为瓶颈
        self._session_locks: Dict[str, threading.RLock] = {}
        self._global_lock = threading.RLock()  # 仅用于管理 session_locks
        self._stop_event = threading.Event()
        self._init_database()
        self._cleanup_thread = None
        if start_cleanup_thread:
            self._cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
            self._cleanup_thread.start()

    @contextmanager
    def _get_connection(self):
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _get_session_lock(self, session_id: str) -> threading.RLock:
        """
        获取指定 session 的锁（session 级别隔离）

        优势：
        - 不同 session 的操作可以并发执行
        - 同一 session 的操作串行执行，保证一致性
        """
        with self._global_lock:
            if session_id not in self._session_locks:
                self._session_locks[session_id] = threading.RLock()
            return self._session_locks[session_id]

    def _init_database(self):
        with self._get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    user_id TEXT,
                    metadata TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT UNIQUE NOT NULL,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    metadata TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)"
            )

            # run_steps: 中间过程步骤，与 assistant 消息通过 message_id 关联
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS run_steps (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    message_id TEXT,
                    step_order INTEGER NOT NULL,
                    step_type TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_run_steps_session_run ON run_steps(session_id, run_id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_run_steps_message_id ON run_steps(message_id)"
            )

            if self.enable_archive:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS sessions_archive (
                        session_id TEXT PRIMARY KEY,
                        user_id TEXT,
                        metadata TEXT,
                        created_at TIMESTAMP,
                        updated_at TIMESTAMP,
                        archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS messages_archive (
                        seq INTEGER,
                        id TEXT,
                        session_id TEXT,
                        role TEXT,
                        content TEXT,
                        metadata TEXT,
                        created_at TIMESTAMP,
                        archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )

    def create_session(self, session_id: str, user_id: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None):
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False)
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO sessions (session_id, user_id, metadata)
                VALUES (?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    user_id=excluded.user_id,
                    metadata=excluded.metadata,
                    updated_at=CURRENT_TIMESTAMP
                """,
                (session_id, user_id, metadata_json)
            )

    def update_session_activity(self, session_id: str):
        with self._get_connection() as conn:
            conn.execute(
                "UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=?",
                (session_id,)
            )

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT session_id, user_id, metadata, created_at, updated_at FROM sessions WHERE session_id=?",
                (session_id,)
            ).fetchone()
            if not row:
                return None
            return {
                "session_id": row["session_id"],
                "user_id": row["user_id"],
                "metadata": json.loads(row["metadata"] or "{}"),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"]
            }

    def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
        message_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        添加消息到会话

        使用 session 级别的锁，确保同一 session 的消息顺序一致
        """
        message_id = message_id or str(uuid.uuid4())
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False)

        # ✨ 使用 session 级别的锁
        with self._get_session_lock(session_id):
            with self._get_connection() as conn:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO sessions (session_id)
                    VALUES (?)
                    """,
                    (session_id,)
                )
                conn.execute(
                    """
                    INSERT INTO messages (id, session_id, role, content, metadata)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (message_id, session_id, role, content, metadata_json)
                )
                conn.execute(
                    "UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=?",
                    (session_id,)
                )

        return {
            "id": message_id,
            "session_id": session_id,
            "role": role,
            "content": content,
            "metadata": metadata or {}
        }

    def insert_compression_message(self, session_id: str, summary_content: str) -> Dict[str, Any]:
        """
        插入一条持久化摘要消息（智能压缩）。

        摘要语义：该条之前的所有内容；metadata 仅存 compression=true，不存 replaces_seqs。

        注意：使用 session 锁确保与其他消息写入的原子性
        """
        # add_message 内部已经使用了 session 锁，这里会自动串行化
        return self.add_message(
            session_id=session_id,
            role="system",
            content=summary_content,
            metadata={"compression": True}
        )

    def add_run_step(
        self,
        session_id: str,
        run_id: str,
        step_type: str,
        payload: Dict[str, Any],
        message_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        写入一条 run 步骤；message_id 可在 FINAL_ANSWER 后通过 update_run_steps_message_id 批量更新。

        使用 session 锁确保 step_order 的连续性
        """
        payload_json = json.dumps(payload, ensure_ascii=False)

        # ✨ 使用 session 级别的锁
        with self._get_session_lock(session_id):
            with self._get_connection() as conn:
                next_order = conn.execute(
                    "SELECT COALESCE(MAX(step_order), 0) + 1 FROM run_steps WHERE session_id=? AND run_id=?",
                    (session_id, run_id)
                ).fetchone()[0]
                conn.execute(
                    """
                    INSERT INTO run_steps (run_id, session_id, message_id, step_order, step_type, payload)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (run_id, session_id, message_id, next_order, step_type, payload_json)
                )
        return {"run_id": run_id, "step_order": next_order, "step_type": step_type}

    def update_run_steps_message_id(self, session_id: str, run_id: str, message_id: str) -> int:
        """
        将某 run 下所有 step 的 message_id 更新为指定值。返回更新的行数。

        使用 session 锁确保更新的原子性
        """
        # ✨ 使用 session 级别的锁
        with self._get_session_lock(session_id):
            with self._get_connection() as conn:
                cur = conn.execute(
                    "UPDATE run_steps SET message_id=? WHERE session_id=? AND run_id=?",
                    (message_id, session_id, run_id)
                )
                return cur.rowcount

    def list_run_steps(
        self,
        run_id: Optional[str] = None,
        message_id: Optional[str] = None,
        session_id: Optional[str] = None,
        limit: int = 500
    ) -> List[Dict[str, Any]]:
        """按 run_id 或 message_id 查询步骤；若传 session_id 则校验归属。"""
        with self._get_connection() as conn:
            if message_id:
                if session_id:
                    rows = conn.execute(
                        """
                        SELECT id, run_id, session_id, message_id, step_order, step_type, payload, created_at
                        FROM run_steps
                        WHERE message_id=? AND session_id=?
                        ORDER BY step_order ASC
                        LIMIT ?
                        """,
                        (message_id, session_id, limit)
                    ).fetchall()
                else:
                    rows = conn.execute(
                        """
                        SELECT id, run_id, session_id, message_id, step_order, step_type, payload, created_at
                        FROM run_steps
                        WHERE message_id=?
                        ORDER BY step_order ASC
                        LIMIT ?
                        """,
                        (message_id, limit)
                    ).fetchall()
            elif run_id:
                if session_id:
                    rows = conn.execute(
                        """
                        SELECT id, run_id, session_id, message_id, step_order, step_type, payload, created_at
                        FROM run_steps
                        WHERE run_id=? AND session_id=?
                        ORDER BY step_order ASC
                        LIMIT ?
                        """,
                        (run_id, session_id, limit)
                    ).fetchall()
                else:
                    rows = conn.execute(
                        """
                        SELECT id, run_id, session_id, message_id, step_order, step_type, payload, created_at
                        FROM run_steps
                        WHERE run_id=?
                        ORDER BY step_order ASC
                        LIMIT ?
                        """,
                        (run_id, limit)
                    ).fetchall()
            else:
                return []
            items = []
            for row in rows:
                items.append({
                    "id": row["id"],
                    "run_id": row["run_id"],
                    "session_id": row["session_id"],
                    "message_id": row["message_id"],
                    "step_order": row["step_order"],
                    "step_type": row["step_type"],
                    "payload": json.loads(row["payload"] or "{}"),
                    "created_at": row["created_at"]
                })
            return items

    def delete_messages_after(
        self,
        session_id: str,
        after_seq: Optional[int] = None,
        after_message_id: Optional[str] = None
    ) -> int:
        """删除某条之后的所有消息（不含该条），并删除关联的 run_steps。返回删除的消息数。"""
        with self._get_connection() as conn:
            if after_message_id is not None:
                row = conn.execute(
                    "SELECT seq FROM messages WHERE session_id=? AND id=?",
                    (session_id, after_message_id)
                ).fetchone()
                if not row:
                    return 0
                after_seq = row["seq"]
            if after_seq is None:
                return 0
            rows = conn.execute(
                "SELECT id FROM messages WHERE session_id=? AND seq > ?",
                (session_id, after_seq)
            ).fetchall()
            message_ids = [r["id"] for r in rows]
            if not message_ids:
                return 0
            placeholders = ",".join(["?"] * len(message_ids))
            conn.execute(
                f"DELETE FROM run_steps WHERE message_id IN ({placeholders})",
                message_ids
            )
            conn.execute(
                f"DELETE FROM messages WHERE session_id=? AND seq > ?",
                (session_id, after_seq)
            )
            conn.execute(
                "UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=?",
                (session_id,)
            )
            return len(message_ids)

    def update_message(
        self,
        message_id: str,
        content: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        session_id: Optional[str] = None,
        role_filter: Optional[str] = None
    ) -> bool:
        """更新消息的 content 和/或 metadata。若 session_id 指定则校验归属；若 role_filter 指定则仅允许该 role。返回是否更新了行。"""
        updates = []
        params = []
        if content is not None:
            updates.append("content = ?")
            params.append(content)
        if metadata is not None:
            updates.append("metadata = ?")
            params.append(json.dumps(metadata, ensure_ascii=False))
        if not updates:
            return False
        with self._get_connection() as conn:
            where = ["id=?"]
            params_where = [message_id]
            if session_id is not None:
                where.append("session_id=?")
                params_where.append(session_id)
            if role_filter is not None:
                where.append("role=?")
                params_where.append(role_filter)
            row = conn.execute(
                f"SELECT seq FROM messages WHERE {' AND '.join(where)}",
                params_where
            ).fetchone()
            if not row:
                return False
            params.extend(params_where)
            cur = conn.execute(
                f"UPDATE messages SET {', '.join(updates)} WHERE {' AND '.join(where)}",
                params
            )
            return cur.rowcount > 0

    def list_messages(
        self,
        session_id: str,
        limit: int = 20,
        offset: int = 0
    ) -> Dict[str, Any]:
        with self._get_connection() as conn:
            total = conn.execute(
                "SELECT COUNT(1) AS cnt FROM messages WHERE session_id=?",
                (session_id,)
            ).fetchone()["cnt"]

            rows = conn.execute(
                """
                SELECT seq, id, role, content, metadata, created_at
                FROM messages
                WHERE session_id=?
                ORDER BY seq ASC
                LIMIT ? OFFSET ?
                """,
                (session_id, limit, offset)
            ).fetchall()

            items = []
            for row in rows:
                items.append({
                    "seq": row["seq"],
                    "id": row["id"],
                    "role": row["role"],
                    "content": row["content"],
                    "metadata": json.loads(row["metadata"] or "{}"),
                    "created_at": row["created_at"]
                })

            return {
                "items": items,
                "total": total,
                "limit": limit,
                "offset": offset,
                "has_more": (offset + limit) < total
            }

    def list_sessions(
        self,
        limit: int = 20,
        offset: int = 0,
        user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        if user_id is not None and str(user_id).strip() == "":
            user_id = None
        with self._get_connection() as conn:
            total = conn.execute(
                """
                SELECT COUNT(1) AS cnt
                FROM sessions
                WHERE (? IS NULL OR user_id = ?)
                """,
                (user_id, user_id)
            ).fetchone()["cnt"]

            rows = conn.execute(
                """
                SELECT
                    s.session_id,
                    s.user_id,
                    s.metadata,
                    s.created_at,
                    s.updated_at,
                    (
                        SELECT content
                        FROM messages m
                        WHERE m.session_id = s.session_id
                        ORDER BY seq DESC
                        LIMIT 1
                    ) AS last_content,
                    (
                        SELECT created_at
                        FROM messages m
                        WHERE m.session_id = s.session_id
                        ORDER BY seq DESC
                        LIMIT 1
                    ) AS last_created_at,
                    (
                        SELECT content
                        FROM messages m
                        WHERE m.session_id = s.session_id
                        ORDER BY seq ASC
                        LIMIT 1
                    ) AS first_content
                FROM sessions s
                WHERE (? IS NULL OR s.user_id = ?)
                ORDER BY s.updated_at DESC
                LIMIT ? OFFSET ?
                """,
                (user_id, user_id, limit, offset)
            ).fetchall()

            items = []
            for row in rows:
                metadata = json.loads(row["metadata"] or "{}")
                title = metadata.get("title")
                if not title:
                    first_content = (row["first_content"] or "").strip()
                    title = first_content[:30] if first_content else ""
                items.append({
                    "session_id": row["session_id"],
                    "user_id": row["user_id"],
                    "metadata": metadata,
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                    "title": title,
                    "last_message": row["last_content"] or "",
                    "last_message_at": row["last_created_at"] or row["updated_at"],
                    "first_message": row["first_content"] or "",
                    "unread_count": int(metadata.get("unread_count") or 0)
                })

            return {
                "items": items,
                "total": total,
                "limit": limit,
                "offset": offset,
                "has_more": (offset + limit) < total
            }

    def get_message_by_seq(self, session_id: str, seq: int) -> Optional[Dict[str, Any]]:
        """按会话和序号获取单条消息。"""
        with self._get_connection() as conn:
            row = conn.execute(
                """
                SELECT seq, id, role, content, metadata, created_at
                FROM messages
                WHERE session_id=? AND seq=?
                """,
                (session_id, seq)
            ).fetchone()
            if not row:
                return None
            return {
                "seq": row["seq"],
                "id": row["id"],
                "role": row["role"],
                "content": row["content"],
                "metadata": json.loads(row["metadata"] or "{}"),
                "created_at": row["created_at"]
            }

    def get_recent_messages(self, session_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            rows = conn.execute(
                """
                SELECT seq, id, role, content, metadata, created_at
                FROM messages
                WHERE session_id=?
                ORDER BY seq DESC
                LIMIT ?
                """,
                (session_id, limit)
            ).fetchall()

            rows = list(reversed(rows))
            items = []
            for row in rows:
                items.append({
                    "seq": row["seq"],
                    "id": row["id"],
                    "role": row["role"],
                    "content": row["content"],
                    "metadata": json.loads(row["metadata"] or "{}"),
                    "created_at": row["created_at"]
                })
            return items

    def cleanup_expired_sessions(self) -> int:
        cutoff = datetime.utcnow() - timedelta(days=self.session_ttl_days)
        cutoff_str = cutoff.strftime("%Y-%m-%d %H:%M:%S")

        with self._get_connection() as conn:
            session_rows = conn.execute(
                "SELECT session_id, user_id, metadata, created_at, updated_at FROM sessions WHERE updated_at < ?",
                (cutoff_str,)
            ).fetchall()

            if not session_rows:
                return 0

            session_ids = [row["session_id"] for row in session_rows]

            if self.enable_archive:
                for row in session_rows:
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO sessions_archive
                        (session_id, user_id, metadata, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (row["session_id"], row["user_id"], row["metadata"], row["created_at"], row["updated_at"])
                    )
                conn.execute(
                    """
                    INSERT INTO messages_archive (seq, id, session_id, role, content, metadata, created_at)
                    SELECT seq, id, session_id, role, content, metadata, created_at
                    FROM messages
                    WHERE session_id IN ({})
                    """.format(",".join(["?"] * len(session_ids))),
                    session_ids
                )

            conn.execute(
                "DELETE FROM messages WHERE session_id IN ({})".format(",".join(["?"] * len(session_ids))),
                session_ids
            )
            conn.execute(
                "DELETE FROM sessions WHERE session_id IN ({})".format(",".join(["?"] * len(session_ids))),
                session_ids
            )
            return len(session_ids)

    def _cleanup_loop(self):
        """后台清理线程：清理过期 session、session 锁和临时数据文件"""
        while not self._stop_event.is_set():
            self.cleanup_expired_sessions()
            self._cleanup_session_locks()  # ✨ 清理不再使用的 session 锁
            self._cleanup_temp_data_files()  # ✨ 清理过期的临时数据文件
            self._stop_event.wait(self.cleanup_interval_seconds)

    def _cleanup_session_locks(self):
        """
        清理不再使用的 session 锁（内存优化）

        策略：删除已过期 session 对应的锁
        """
        try:
            # 获取所有活跃的 session_id
            with self._get_connection() as conn:
                active_sessions = set(
                    row[0] for row in conn.execute(
                        "SELECT session_id FROM sessions WHERE updated_at > datetime('now', '-30 days')"
                    ).fetchall()
                )

            # 清理不在活跃列表中的锁
            with self._global_lock:
                expired_sessions = set(self._session_locks.keys()) - active_sessions
                for session_id in expired_sessions:
                    del self._session_locks[session_id]

                if expired_sessions:
                    import logging
                    logger = logging.getLogger(__name__)
                    logger.info(f"清理了 {len(expired_sessions)} 个过期 session 锁")
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.warning(f"清理 session 锁失败: {e}")

    def _cleanup_temp_data_files(self):
        """
        清理过期的临时数据文件（内存优化）

        策略：删除 static/temp_data/ 目录下超过 1 天的 JSON 文件
        这些文件由 ObservationFormatter 生成，用于存储大数据工具结果
        """
        import logging
        import os
        import time

        logger = logging.getLogger(__name__)

        try:
            # 临时数据目录（与 ObservationFormatter 保持一致）
            temp_data_dir = Path(__file__).parent / "static" / "temp_data"

            if not temp_data_dir.exists():
                return

            # 1 天前的时间戳
            cutoff_time = time.time() - (24 * 60 * 60)
            deleted_count = 0

            # 遍历目录中的所有 JSON 文件
            for file_path in temp_data_dir.glob("data_*.json"):
                try:
                    # 检查文件修改时间
                    if file_path.stat().st_mtime < cutoff_time:
                        file_path.unlink()
                        deleted_count += 1
                except Exception as e:
                    logger.warning(f"删除临时文件失败 {file_path}: {e}")

            if deleted_count > 0:
                logger.info(f"清理了 {deleted_count} 个过期临时数据文件")

        except Exception as e:
            logger.warning(f"清理临时数据文件失败: {e}")

    def close(self):
        self._stop_event.set()
        if self._cleanup_thread and self._cleanup_thread.is_alive():
            self._cleanup_thread.join(timeout=2)

    def backup(self, backup_dir: str, compress: bool = True, cleanup_days: int = 30) -> bool:
        return _backup_database(self.db_path, Path(backup_dir), compress=compress, cleanup_days=cleanup_days)

    def restore(self, backup_file: str) -> bool:
        return _restore_database(Path(backup_file), self.db_path)
