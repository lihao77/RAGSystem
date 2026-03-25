import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agents.artifacts import ArtifactStore
from config import get_config
from execution.persistence.session_trace_writer import SessionTraceWriter
from utils.backup_database import backup_database as _backup_database
from utils.backup_database import restore_database as _restore_database


class ConversationStore:
    def __init__(
        self,
        db_path: Optional[str] = None,
        cleanup_interval_seconds: int = 300,
        session_ttl_days: int = 30,
        enable_archive: bool = True,
        start_cleanup_thread: bool = True,
        artifact_store: Optional[ArtifactStore] = None,
    ):
        if db_path is None:
            config = get_config()
            db_path = config.vector_store.sqlite_vec.database_path

        if not db_path:
            from tools.paths.path_resolution import RAGSYSTEM_DB
            db_path = str(RAGSYSTEM_DB)

        db_path = Path(db_path)
        if not db_path.is_absolute():
            db_path = Path(__file__).parent / db_path

        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self.cleanup_interval_seconds = cleanup_interval_seconds
        self.session_ttl_days = session_ttl_days
        self.enable_archive = enable_archive
        self.artifact_store = artifact_store or ArtifactStore()
        self.trace_writer = SessionTraceWriter()

        # ✨ 改进：使用 session 级别的锁，避免全局锁成为瓶颈
        self._session_locks: Dict[str, threading.RLock] = {}
        self._global_lock = threading.RLock()  # 仅用于管理 session_locks
        self._stop_event = threading.Event()
        self._init_database()
        self._cleanup_thread = None
        if start_cleanup_thread:
            self._cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
            self._cleanup_thread.start()

    @staticmethod
    def _column_exists(conn, table_name: str, column_name: str) -> bool:
        rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        return any(row[1] == column_name for row in rows)

    def _ensure_column(self, conn, table_name: str, column_name: str, definition: str) -> None:
        if self._column_exists(conn, table_name, column_name):
            return
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")

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
                    thread_key TEXT NOT NULL DEFAULT 'root',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
                )
                """
            )
            self._ensure_column(conn, 'messages', 'thread_key', "TEXT NOT NULL DEFAULT 'root'")
            self._ensure_column(conn, 'messages', 'child_agent_id', 'TEXT')

            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_session_thread_seq ON messages(session_id, thread_key, seq)"
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
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_run_steps_session_type_id ON run_steps(session_id, step_type, id DESC)"
            )

            # runs: 运行记录
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    entrypoint TEXT,
                    status TEXT NOT NULL DEFAULT 'running',
                    task_summary TEXT,
                    user_id TEXT,
                    agent_name TEXT,
                    thread_key TEXT NOT NULL DEFAULT 'root',
                    parent_run_id TEXT,
                    parent_call_id TEXT,
                    final_message_id TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
                )
                """
            )
            self._ensure_column(conn, 'runs', 'thread_key', "TEXT NOT NULL DEFAULT 'root'")
            self._ensure_column(conn, 'runs', 'parent_run_id', 'TEXT')
            self._ensure_column(conn, 'runs', 'parent_call_id', 'TEXT')
            self._ensure_column(conn, 'runs', 'child_agent_id', 'TEXT')
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_runs_session_thread_created ON runs(session_id, thread_key, created_at)"
            )

            # resources: 文件资源记录
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS resources (
                    resource_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    run_id TEXT,
                    step_id INTEGER,
                    message_id TEXT,
                    resource_type TEXT NOT NULL,
                    sub_type TEXT,
                    title TEXT,
                    path TEXT NOT NULL,
                    source_tool TEXT,
                    scope TEXT NOT NULL DEFAULT 'transient',
                    metadata TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_resources_session_run ON resources(session_id, run_id)"
            )

            # step_resources: 步骤与资源的关联表
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS step_resources (
                    step_id INTEGER NOT NULL,
                    resource_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    run_id TEXT,
                    PRIMARY KEY(step_id, resource_id)
                )
                """
            )

            # step_resources: 步骤与资源的关联表
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS step_resources (
                    step_id INTEGER NOT NULL,
                    resource_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    run_id TEXT,
                    PRIMARY KEY(step_id, resource_id)
                )
                """
            )

            # child_agents: 子 Agent 会话实体
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS child_agents (
                    child_agent_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    thread_key TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_by_run_id TEXT,
                    created_by_call_id TEXT,
                    parent_run_id TEXT,
                    parent_call_id TEXT,
                    last_run_id TEXT,
                    metadata TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_child_agents_session_created ON child_agents(session_id, created_at DESC)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_child_agents_session_agent ON child_agents(session_id, agent_name, created_at DESC)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_child_agents_session_thread ON child_agents(session_id, thread_key)"
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

    def delete_session(self, session_id: str) -> bool:
        """
        删除会话及其所有关联数据（消息、run_steps、resources）。
        同时清理 transient/export/session scope 的文件，保留 workspace 文件。

        Returns:
            bool: 是否成功删除（True 表示删除了会话，False 表示会话不存在）
        """
        lock = self._get_session_lock(session_id)
        with lock:
            # 先收集需要清理的文件路径
            files_to_delete = []
            with self._get_connection() as conn:
                res_rows = conn.execute(
                    "SELECT path, scope FROM resources WHERE session_id=?",
                    (session_id,)
                ).fetchall()
                for row in res_rows:
                    if row["scope"] in ("transient", "export", "session"):
                        files_to_delete.append(row["path"])

                # 删除关联表
                conn.execute("DELETE FROM step_resources WHERE session_id=?", (session_id,))
                conn.execute("DELETE FROM resources WHERE session_id=?", (session_id,))
                conn.execute("DELETE FROM run_steps WHERE session_id=?", (session_id,))
                conn.execute("DELETE FROM runs WHERE session_id=?", (session_id,))

                # 删除会话（会自动级联删除 messages）
                cursor = conn.execute(
                    "DELETE FROM sessions WHERE session_id=?",
                    (session_id,)
                )
                deleted = cursor.rowcount > 0

            # 在锁外清理文件
            for file_path in files_to_delete:
                try:
                    p = Path(file_path)
                    if p.exists():
                        p.unlink()
                except Exception as e:
                    logging.getLogger(__name__).warning('删除资源文件失败 %s: %s', file_path, e)

            # 清理 session 锁
            with self._global_lock:
                if session_id in self._session_locks:
                    del self._session_locks[session_id]

            return deleted

    def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
        message_id: Optional[str] = None,
        thread_key: str = 'root',
        child_agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        添加消息到会话

        使用 session 级别的锁，确保同一 session 的消息顺序一致
        """
        message_id = message_id or str(uuid.uuid4())
        resolved_metadata = dict(metadata or {})
        resolved_thread_key = (thread_key or resolved_metadata.get('thread_key') or 'root').strip() or 'root'
        resolved_child_agent_id = child_agent_id or resolved_metadata.get('child_agent_id')
        resolved_metadata['thread_key'] = resolved_thread_key
        if resolved_child_agent_id:
            resolved_metadata['child_agent_id'] = resolved_child_agent_id
        metadata_json = json.dumps(resolved_metadata, ensure_ascii=False)

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
                    INSERT INTO messages (id, session_id, role, content, metadata, thread_key, child_agent_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (message_id, session_id, role, content, metadata_json, resolved_thread_key, resolved_child_agent_id)
                )
                conn.execute(
                    "UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=?",
                    (session_id,)
                )
                row = conn.execute(
                    "SELECT seq FROM messages WHERE id=?", (message_id,)
                ).fetchone()
                seq = row[0] if row else None

        self.trace_writer.append_message(
            session_id=session_id,
            run_id=resolved_metadata.get('run_id', ''),
            role=role,
            content=content,
            metadata=resolved_metadata,
            message_id=message_id,
            seq=seq,
            source='store',
        )

        return {
            "id": message_id,
            "seq": seq,
            "session_id": session_id,
            "role": role,
            "content": content,
            "metadata": resolved_metadata,
            "thread_key": resolved_thread_key,
            "child_agent_id": resolved_child_agent_id,
        }

    def insert_compression_message(
        self,
        session_id: str,
        summary_content: str,
        replaces_up_to_seq: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        插入一条持久化摘要消息（智能压缩）。

        replaces_up_to_seq：被压缩的最后一条原始消息的 seq。
        resolve_compression_view 凭此字段判断"摘要之后的消息"，
        从而正确保留 segment 之后、摘要之前的 remaining 消息。
        """
        meta: Dict[str, Any] = {"compression": True}
        if replaces_up_to_seq is not None:
            meta["replaces_up_to_seq"] = replaces_up_to_seq
        return self.add_message(
            session_id=session_id,
            role="assistant",
            content=summary_content,
            metadata=meta,
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
                cursor = conn.execute(
                    """
                    INSERT INTO run_steps (run_id, session_id, message_id, step_order, step_type, payload)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (run_id, session_id, message_id, next_order, step_type, payload_json)
                )
                step_id = cursor.lastrowid
        self.trace_writer.append_run_step(
            session_id=session_id,
            run_id=run_id,
            step_type=step_type,
            payload={
                'step_order': next_order,
                'message_id': message_id,
                'payload': payload,
            },
        )
        return {"id": step_id, "run_id": run_id, "step_order": next_order, "step_type": step_type}

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
            step_ids = [row["id"] for row in rows]
            resource_refs_by_step: Dict[int, List[Dict[str, str]]] = {}
            if step_ids:
                placeholders = ",".join(["?"] * len(step_ids))
                resource_rows = conn.execute(
                    f"SELECT step_id, resource_id FROM step_resources WHERE step_id IN ({placeholders})",
                    step_ids,
                ).fetchall()
                for resource_row in resource_rows:
                    resource_refs_by_step.setdefault(resource_row["step_id"], []).append({
                        "resource_id": resource_row["resource_id"]
                    })

            items = []
            for row in rows:
                payload = json.loads(row["payload"] or "{}")
                step_id = row["id"]
                payload["resource_refs"] = resource_refs_by_step.get(step_id, [])
                items.append({
                    "id": step_id,
                    "run_id": row["run_id"],
                    "session_id": row["session_id"],
                    "message_id": row["message_id"],
                    "step_order": row["step_order"],
                    "step_type": row["step_type"],
                    "payload": payload,
                    "created_at": row["created_at"]
                })
            return items

    def get_tool_call_raw_result(
        self,
        session_id: str,
        call_id: str,
    ) -> Optional[Dict[str, Any]]:
        """按会话和 call_id 获取工具调用结束事件中持久化的原始结果。"""
        with self._get_connection() as conn:
            row = conn.execute(
                """
                SELECT id, run_id, session_id, message_id, step_order, step_type, payload, created_at
                FROM run_steps
                WHERE session_id=?
                  AND step_type=?
                  AND json_extract(payload, '$.kind')='tool'
                  AND json_extract(payload, '$.phase')='end'
                  AND json_extract(payload, '$.call_id')=?
                ORDER BY id DESC
                LIMIT 1
                """,
                (session_id, "execution.step", call_id)
            ).fetchone()

        if not row:
            return None

        payload = json.loads(row["payload"] or "{}")
        return {
            "id": row["id"],
            "run_id": row["run_id"],
            "session_id": row["session_id"],
            "message_id": row["message_id"],
            "step_order": row["step_order"],
            "step_type": row["step_type"],
            "created_at": row["created_at"],
            "tool_name": payload.get("tool_name"),
            "result_preview": payload.get("result_preview") or payload.get("result"),
            "raw_result": payload.get("raw_result"),
            "raw_result_ref": payload.get("raw_result_ref") or {},
            "raw_result_available": bool(payload.get("raw_result_available") or payload.get("raw_result") is not None),
        }

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
        offset: int = 0,
        thread_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        resolved_thread_key = (thread_key or '').strip() or None
        with self._get_connection() as conn:
            total = conn.execute(
                "SELECT COUNT(1) AS cnt FROM messages WHERE session_id=? AND (? IS NULL OR thread_key=?)",
                (session_id, resolved_thread_key, resolved_thread_key)
            ).fetchone()["cnt"]

            rows = conn.execute(
                """
                SELECT seq, id, role, content, metadata, thread_key, child_agent_id, created_at
                FROM messages
                WHERE session_id=? AND (? IS NULL OR thread_key=?)
                ORDER BY seq ASC
                LIMIT ? OFFSET ?
                """,
                (session_id, resolved_thread_key, resolved_thread_key, limit, offset)
            ).fetchall()

            items = []
            for row in rows:
                items.append({
                    "seq": row["seq"],
                    "id": row["id"],
                    "role": row["role"],
                    "content": row["content"],
                    "metadata": json.loads(row["metadata"] or "{}"),
                    "thread_key": row["thread_key"],
                    "child_agent_id": row["child_agent_id"],
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
                SELECT seq, id, role, content, metadata, thread_key, child_agent_id, created_at
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
                "thread_key": row["thread_key"],
                "created_at": row["created_at"]
            }

    def get_recent_messages(
        self,
        session_id: str,
        limit: int = 20,
        thread_key: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        resolved_thread_key = (thread_key or '').strip() or None
        with self._get_connection() as conn:
            rows = conn.execute(
                """
                SELECT seq, id, role, content, metadata, thread_key, child_agent_id, created_at
                FROM messages
                WHERE session_id=? AND (? IS NULL OR thread_key=?)
                ORDER BY seq DESC
                LIMIT ?
                """,
                (session_id, resolved_thread_key, resolved_thread_key, limit)
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
                    "thread_key": row["thread_key"],
                    "child_agent_id": row["child_agent_id"],
                    "created_at": row["created_at"]
                })
            return items

    def get_recent_messages_by_thread(self, session_id: str, thread_key: str, limit: int = 20) -> List[Dict[str, Any]]:
        return self.get_recent_messages(session_id=session_id, limit=limit, thread_key=thread_key)

    def cleanup_expired_sessions(self) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.session_ttl_days)
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

        策略：删除超过 1 天的 observation artifact 文件
        """
        import logging

        logger = logging.getLogger(__name__)

        try:
            deleted_count = self.artifact_store.cleanup(24 * 60 * 60)
            if deleted_count > 0:
                logger.info(f"清理了 {deleted_count} 个过期临时数据文件")

        except Exception as e:
            logger.warning(f"清理临时数据文件失败: {e}")

    def create_child_agent(
        self,
        *,
        child_agent_id: str,
        session_id: str,
        agent_name: str,
        thread_key: Optional[str] = None,
        created_by_run_id: Optional[str] = None,
        created_by_call_id: Optional[str] = None,
        parent_run_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        last_run_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        status: str = 'active',
    ) -> Dict[str, Any]:
        resolved_thread_key = (thread_key or f'child:{child_agent_id}').strip() or f'child:{child_agent_id}'
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False)
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO child_agents (
                    child_agent_id, session_id, agent_name, thread_key, status,
                    created_by_run_id, created_by_call_id, parent_run_id, parent_call_id,
                    last_run_id, metadata
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    child_agent_id,
                    session_id,
                    agent_name,
                    resolved_thread_key,
                    status,
                    created_by_run_id,
                    created_by_call_id,
                    parent_run_id,
                    parent_call_id,
                    last_run_id,
                    metadata_json,
                ),
            )
        return {
            'child_agent_id': child_agent_id,
            'session_id': session_id,
            'agent_name': agent_name,
            'thread_key': resolved_thread_key,
            'status': status,
            'created_by_run_id': created_by_run_id,
            'created_by_call_id': created_by_call_id,
            'parent_run_id': parent_run_id,
            'parent_call_id': parent_call_id,
            'last_run_id': last_run_id,
            'metadata': metadata or {},
        }

    def get_child_agent(self, *, session_id: str, child_agent_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            row = conn.execute(
                """
                SELECT child_agent_id, session_id, agent_name, thread_key, status,
                       created_by_run_id, created_by_call_id, parent_run_id, parent_call_id,
                       last_run_id, metadata, created_at, updated_at
                FROM child_agents
                WHERE session_id=? AND child_agent_id=?
                """,
                (session_id, child_agent_id),
            ).fetchone()
            if not row:
                return None
            return {
                'child_agent_id': row['child_agent_id'],
                'session_id': row['session_id'],
                'agent_name': row['agent_name'],
                'thread_key': row['thread_key'],
                'status': row['status'],
                'created_by_run_id': row['created_by_run_id'],
                'created_by_call_id': row['created_by_call_id'],
                'parent_run_id': row['parent_run_id'],
                'parent_call_id': row['parent_call_id'],
                'last_run_id': row['last_run_id'],
                'metadata': json.loads(row['metadata'] or '{}'),
                'created_at': row['created_at'],
                'updated_at': row['updated_at'],
            }

    def update_child_agent_last_run(
        self,
        *,
        session_id: str,
        child_agent_id: str,
        last_run_id: str,
        status: Optional[str] = None,
    ) -> bool:
        updates = ['last_run_id=?', 'updated_at=CURRENT_TIMESTAMP']
        params: List[Any] = [last_run_id]
        if status is not None:
            updates.insert(1, 'status=?')
            params.append(status)
        params.extend([session_id, child_agent_id])
        with self._get_connection() as conn:
            cur = conn.execute(
                f"UPDATE child_agents SET {', '.join(updates)} WHERE session_id=? AND child_agent_id=?",
                params,
            )
            return cur.rowcount > 0

    def list_child_agents(self, *, session_id: str, agent_name: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
        with self._get_connection() as conn:
            rows = conn.execute(
                """
                SELECT child_agent_id, session_id, agent_name, thread_key, status,
                       created_by_run_id, created_by_call_id, parent_run_id, parent_call_id,
                       last_run_id, metadata, created_at, updated_at
                FROM child_agents
                WHERE session_id=? AND (? IS NULL OR agent_name=?)
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (session_id, agent_name, agent_name, limit),
            ).fetchall()
            items = []
            for row in rows:
                items.append({
                    'child_agent_id': row['child_agent_id'],
                    'session_id': row['session_id'],
                    'agent_name': row['agent_name'],
                    'thread_key': row['thread_key'],
                    'status': row['status'],
                    'created_by_run_id': row['created_by_run_id'],
                    'created_by_call_id': row['created_by_call_id'],
                    'parent_run_id': row['parent_run_id'],
                    'parent_call_id': row['parent_call_id'],
                    'last_run_id': row['last_run_id'],
                    'metadata': json.loads(row['metadata'] or '{}'),
                    'created_at': row['created_at'],
                    'updated_at': row['updated_at'],
                })
            return {'items': items, 'total': len(items)}

    def get_recent_messages_by_child_agent(self, session_id: str, child_agent_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        child_agent = self.get_child_agent(session_id=session_id, child_agent_id=child_agent_id)
        if not child_agent:
            return []
        return self.get_recent_messages(
            session_id=session_id,
            limit=limit,
            thread_key=child_agent['thread_key'],
        )

    # ── Run 管理 ──────────────────────────────────────────────────

    def create_run(
        self,
        run_id: str,
        session_id: str,
        entrypoint: str = "execute",
        status: str = "running",
        task_summary: str = "",
        user_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        thread_key: str = 'root',
        parent_run_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        child_agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        resolved_thread_key = (thread_key or 'root').strip() or 'root'
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO runs (
                    run_id, session_id, entrypoint, status, task_summary,
                    user_id, agent_name, thread_key, parent_run_id, parent_call_id, child_agent_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    session_id,
                    entrypoint,
                    status,
                    task_summary,
                    user_id,
                    agent_name,
                    resolved_thread_key,
                    parent_run_id,
                    parent_call_id,
                    child_agent_id,
                ),
            )
        return {
            "run_id": run_id,
            "session_id": session_id,
            "status": status,
            "thread_key": resolved_thread_key,
            "parent_run_id": parent_run_id,
            "parent_call_id": parent_call_id,
            "child_agent_id": child_agent_id,
        }

    def update_run_status(
        self,
        run_id: str,
        session_id: str,
        status: str,
        final_message_id: Optional[str] = None,
    ) -> bool:
        with self._get_connection() as conn:
            cur = conn.execute(
                """
                UPDATE runs SET status=?, final_message_id=?, updated_at=CURRENT_TIMESTAMP
                WHERE run_id=? AND session_id=?
                """,
                (status, final_message_id, run_id, session_id),
            )
            return cur.rowcount > 0

    def list_runs(self, session_id: str, limit: int = 50) -> Dict[str, Any]:
        with self._get_connection() as conn:
            rows = conn.execute(
                """
                SELECT run_id, session_id, entrypoint, status, task_summary,
                       user_id, agent_name, thread_key, parent_run_id, parent_call_id,
                       child_agent_id, final_message_id, created_at, updated_at
                FROM runs WHERE session_id=? ORDER BY created_at DESC LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()
            items = []
            for row in rows:
                items.append({
                    "run_id": row["run_id"],
                    "session_id": row["session_id"],
                    "entrypoint": row["entrypoint"],
                    "status": row["status"],
                    "task_summary": row["task_summary"],
                    "user_id": row["user_id"],
                    "agent_name": row["agent_name"],
                    "thread_key": row["thread_key"],
                    "parent_run_id": row["parent_run_id"],
                    "parent_call_id": row["parent_call_id"],
                    "child_agent_id": row["child_agent_id"],
                    "final_message_id": row["final_message_id"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                })
            return {"items": items, "total": len(items)}

    # ── Resource 管理 ─────────────────────────────────────────────

    def register_resource(
        self,
        session_id: str,
        path: str,
        resource_type: str,
        source_tool: str = "",
        *,
        run_id: Optional[str] = None,
        step_id: Optional[int] = None,
        message_id: Optional[str] = None,
        sub_type: Optional[str] = None,
        title: Optional[str] = None,
        scope: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        resource_id = str(uuid.uuid4())
        if scope is None:
            scope = self._infer_scope(path, session_id=session_id)
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False)
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO resources
                (resource_id, session_id, run_id, step_id, message_id,
                 resource_type, sub_type, title, path, source_tool, scope, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (resource_id, session_id, run_id, step_id, message_id,
                 resource_type, sub_type, title, path, source_tool, scope, metadata_json),
            )
        return {
            "resource_id": resource_id,
            "session_id": session_id,
            "path": path,
            "scope": scope,
            "resource_type": resource_type,
        }

    def list_resources(
        self,
        session_id: str,
        run_id: Optional[str] = None,
        limit: int = 100,
    ) -> Dict[str, Any]:
        with self._get_connection() as conn:
            if run_id:
                rows = conn.execute(
                    "SELECT * FROM resources WHERE session_id=? AND run_id=? ORDER BY created_at DESC LIMIT ?",
                    (session_id, run_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM resources WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
                    (session_id, limit),
                ).fetchall()
            items = []
            for row in rows:
                items.append({
                    "resource_id": row["resource_id"],
                    "session_id": row["session_id"],
                    "run_id": row["run_id"],
                    "path": row["path"],
                    "resource_type": row["resource_type"],
                    "sub_type": row["sub_type"],
                    "title": row["title"],
                    "scope": row["scope"],
                    "source_tool": row["source_tool"],
                })
            return {"items": items, "total": len(items)}

    def attach_resource_to_step(
        self,
        session_id: str,
        run_id: str,
        step_id: int,
        resource_id: str,
    ) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO step_resources (step_id, resource_id, session_id, run_id)
                VALUES (?, ?, ?, ?)
                """,
                (step_id, resource_id, session_id, run_id),
            )

    def _infer_scope(self, path: str, *, session_id: Optional[str] = None) -> str:
        """根据文件路径推断资源 scope。"""
        from tools.paths.path_resolution import infer_resource_scope

        workspace_root = None
        if session_id:
            session = self.get_session(session_id)
            metadata = (session or {}).get('metadata') or {}
            workspace_root = metadata.get('workspace_root')
        return infer_resource_scope(path, workspace_root=workspace_root)

    def close(self):
        self._stop_event.set()
        if self._cleanup_thread and self._cleanup_thread.is_alive():
            self._cleanup_thread.join(timeout=2)

    def backup(self, backup_dir: str, compress: bool = True, cleanup_days: int = 30) -> bool:
        return _backup_database(self.db_path, Path(backup_dir), compress=compress, cleanup_days=cleanup_days)

    def restore(self, backup_file: str) -> bool:
        return _restore_database(Path(backup_file), self.db_path)
