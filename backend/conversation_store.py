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

        self._lock = threading.RLock()
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
        message_id = message_id or str(uuid.uuid4())
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False)

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
        while not self._stop_event.is_set():
            self.cleanup_expired_sessions()
            self._stop_event.wait(self.cleanup_interval_seconds)

    def close(self):
        self._stop_event.set()
        if self._cleanup_thread and self._cleanup_thread.is_alive():
            self._cleanup_thread.join(timeout=2)

    def backup(self, backup_dir: str, compress: bool = True, cleanup_days: int = 30) -> bool:
        return _backup_database(self.db_path, Path(backup_dir), compress=compress, cleanup_days=cleanup_days)

    def restore(self, backup_file: str) -> bool:
        return _restore_database(Path(backup_file), self.db_path)
