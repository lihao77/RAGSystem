"""
检查点管理器

在智能体执行的关键节点保存检查点，支持从失败点恢复。
"""

import json
import logging
import sqlite3
from typing import Dict, List, Optional
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


class CheckpointManager:
    """
    检查点管理器

    使用 SQLite 存储检查点数据，支持：
    - 保存执行检查点
    - 从检查点恢复
    - 清理过期检查点
    """

    def __init__(self, db_path: str = "data/checkpoints.db"):
        """
        初始化检查点管理器

        Args:
            db_path: SQLite 数据库路径
        """
        self.db_path = db_path
        self._ensure_db_exists()

    def _ensure_db_exists(self):
        """确保数据库和表存在"""
        # 确保目录存在
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        # 创建检查点表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS checkpoints (
                checkpoint_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                round INTEGER NOT NULL,
                messages TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT NOT NULL
            )
        """)

        # 创建索引
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_session_id ON checkpoints(session_id)
        """)

        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_created_at ON checkpoints(created_at)
        """)

        conn.commit()
        conn.close()

    def save_checkpoint(
        self,
        session_id: str,
        agent_name: str,
        round: int,
        messages: List[Dict],
        metadata: Optional[Dict] = None
    ) -> str:
        """
        保存检查点

        Args:
            session_id: 会话 ID
            agent_name: 智能体名称
            round: 当前轮次
            messages: 消息列表
            metadata: 元数据（可选）

        Returns:
            str: 检查点 ID
        """
        checkpoint_id = f"{session_id}_{agent_name}_r{round}"
        created_at = datetime.now().isoformat()

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        try:
            cursor.execute("""
                INSERT OR REPLACE INTO checkpoints
                (checkpoint_id, session_id, agent_name, round, messages, metadata, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                checkpoint_id,
                session_id,
                agent_name,
                round,
                json.dumps(messages, ensure_ascii=False),
                json.dumps(metadata or {}, ensure_ascii=False),
                created_at
            ))

            conn.commit()
            logger.info(f"已保存检查点: {checkpoint_id}")
            return checkpoint_id

        except Exception as e:
            logger.error(f"保存检查点失败: {e}")
            raise
        finally:
            conn.close()

    def load_checkpoint(self, checkpoint_id: str) -> Optional[Dict]:
        """
        加载检查点

        Args:
            checkpoint_id: 检查点 ID

        Returns:
            dict: 检查点数据，不存在则返回 None
        """
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        try:
            cursor.execute("""
                SELECT session_id, agent_name, round, messages, metadata, created_at
                FROM checkpoints
                WHERE checkpoint_id = ?
            """, (checkpoint_id,))

            row = cursor.fetchone()
            if not row:
                return None

            return {
                "checkpoint_id": checkpoint_id,
                "session_id": row[0],
                "agent_name": row[1],
                "round": row[2],
                "messages": json.loads(row[3]),
                "metadata": json.loads(row[4]),
                "created_at": row[5]
            }

        except Exception as e:
            logger.error(f"加载检查点失败: {e}")
            return None
        finally:
            conn.close()

    def get_latest_checkpoint(self, session_id: str, agent_name: str = None) -> Optional[Dict]:
        """
        获取最新检查点

        Args:
            session_id: 会话 ID
            agent_name: 智能体名称（可选）

        Returns:
            dict: 最新检查点数据，不存在则返回 None
        """
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        try:
            if agent_name:
                cursor.execute("""
                    SELECT checkpoint_id, session_id, agent_name, round, messages, metadata, created_at
                    FROM checkpoints
                    WHERE session_id = ? AND agent_name = ?
                    ORDER BY round DESC
                    LIMIT 1
                """, (session_id, agent_name))
            else:
                cursor.execute("""
                    SELECT checkpoint_id, session_id, agent_name, round, messages, metadata, created_at
                    FROM checkpoints
                    WHERE session_id = ?
                    ORDER BY round DESC
                    LIMIT 1
                """, (session_id,))

            row = cursor.fetchone()
            if not row:
                return None

            return {
                "checkpoint_id": row[0],
                "session_id": row[1],
                "agent_name": row[2],
                "round": row[3],
                "messages": json.loads(row[4]),
                "metadata": json.loads(row[5]),
                "created_at": row[6]
            }

        except Exception as e:
            logger.error(f"获取最新检查点失败: {e}")
            return None
        finally:
            conn.close()

    def list_checkpoints(
        self,
        session_id: str,
        agent_name: str = None,
        limit: int = 10
    ) -> List[Dict]:
        """
        列出检查点

        Args:
            session_id: 会话 ID
            agent_name: 智能体名称（可选）
            limit: 返回数量限制

        Returns:
            list: 检查点列表
        """
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        try:
            if agent_name:
                cursor.execute("""
                    SELECT checkpoint_id, session_id, agent_name, round, created_at
                    FROM checkpoints
                    WHERE session_id = ? AND agent_name = ?
                    ORDER BY round DESC
                    LIMIT ?
                """, (session_id, agent_name, limit))
            else:
                cursor.execute("""
                    SELECT checkpoint_id, session_id, agent_name, round, created_at
                    FROM checkpoints
                    WHERE session_id = ?
                    ORDER BY round DESC
                    LIMIT ?
                """, (session_id, limit))

            rows = cursor.fetchall()
            return [
                {
                    "checkpoint_id": row[0],
                    "session_id": row[1],
                    "agent_name": row[2],
                    "round": row[3],
                    "created_at": row[4]
                }
                for row in rows
            ]

        except Exception as e:
            logger.error(f"列出检查点失败: {e}")
            return []
        finally:
            conn.close()

    def delete_checkpoint(self, checkpoint_id: str) -> bool:
        """
        删除检查点

        Args:
            checkpoint_id: 检查点 ID

        Returns:
            bool: 是否删除成功
        """
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        try:
            cursor.execute("""
                DELETE FROM checkpoints
                WHERE checkpoint_id = ?
            """, (checkpoint_id,))

            conn.commit()
            deleted = cursor.rowcount > 0
            if deleted:
                logger.info(f"已删除检查点: {checkpoint_id}")
            return deleted

        except Exception as e:
            logger.error(f"删除检查点失败: {e}")
            return False
        finally:
            conn.close()

    def delete_session_checkpoints(self, session_id: str) -> int:
        """
        删除会话的所有检查点

        Args:
            session_id: 会话 ID

        Returns:
            int: 删除的检查点数量
        """
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        try:
            cursor.execute("""
                DELETE FROM checkpoints
                WHERE session_id = ?
            """, (session_id,))

            conn.commit()
            deleted_count = cursor.rowcount
            logger.info(f"已删除会话 {session_id} 的 {deleted_count} 个检查点")
            return deleted_count

        except Exception as e:
            logger.error(f"删除会话检查点失败: {e}")
            return 0
        finally:
            conn.close()

    def cleanup_old_checkpoints(self, days: int = 7) -> int:
        """
        清理过期检查点

        Args:
            days: 保留天数（默认 7 天）

        Returns:
            int: 删除的检查点数量
        """
        from datetime import timedelta

        cutoff_date = (datetime.now() - timedelta(days=days)).isoformat()

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        try:
            cursor.execute("""
                DELETE FROM checkpoints
                WHERE created_at < ?
            """, (cutoff_date,))

            conn.commit()
            deleted_count = cursor.rowcount
            logger.info(f"已清理 {deleted_count} 个过期检查点（{days} 天前）")
            return deleted_count

        except Exception as e:
            logger.error(f"清理过期检查点失败: {e}")
            return 0
        finally:
            conn.close()
