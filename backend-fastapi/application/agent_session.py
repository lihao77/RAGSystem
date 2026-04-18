# -*- coding: utf-8 -*-
"""Agent session use cases."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from services.conversation_store import ConversationStore
from runtime.dependencies import get_runtime_dependency
from schemas.session import normalize_session_metadata

logger = logging.getLogger(__name__)


class AgentSessionApplication:
    """Own session and conversation persistence workflows."""

    _DROPPED_EXECUTION_STEP_FIELDS = {
        'event_id',
        'timestamp',
        'source_event_type',
        'node_id',
        'parent_node_id',
        'child_agent_id',
        'mode',
        'raw_result',
        'raw_result_ref',
        'resource_refs',
    }
    _MAX_CHILD_AGENTS_CLEANUP = 500

    def __init__(self, *, conversation_store: Optional[ConversationStore] = None):
        self._conversation_store = conversation_store or ConversationStore()

    @classmethod
    def _compact_execution_step(cls, payload: Dict[str, Any]) -> Dict[str, Any]:
        compact = {
            key: value
            for key, value in (payload or {}).items()
            if key not in cls._DROPPED_EXECUTION_STEP_FIELDS
        }
        if compact.get('result_preview') is not None:
            compact.pop('result', None)
        return compact

    @staticmethod
    def _is_visible_root_message(item: Dict[str, Any]) -> bool:
        metadata = item.get('metadata') or {}
        if metadata.get('react_intermediate'):
            return False
        if metadata.get('visible_to_user') is False:
            return False
        if metadata.get('conversation_scope') == 'child':
            return False
        if item.get('thread_key') not in (None, '', 'root'):
            return False
        return True

    def get_conversation_store(self) -> ConversationStore:
        return self._conversation_store

    def create_session(
        self,
        *,
        session_id: str,
        user_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        metadata = normalize_session_metadata(metadata or {})
        self._conversation_store.create_session(session_id=session_id, user_id=user_id, metadata=metadata)
        return {
            'session_id': session_id,
            'user_id': user_id,
            'metadata': metadata,
        }

    def list_sessions(self, *, limit: int = 20, offset: int = 0, user_id: Optional[str] = None) -> Dict[str, Any]:
        return self._conversation_store.list_sessions(limit=limit, offset=offset, user_id=user_id)

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        return self._conversation_store.get_session(session_id=session_id)

    def _cleanup_child_worktrees(self, *, session_id: str, child_agents: list[dict], fallback_workspace_root: str = '') -> None:
        from utils.worktree import remove_worktree

        for child in child_agents:
            metadata = child.get('metadata') or {}
            if not metadata.get('uses_worktree'):
                continue
            original_workspace = metadata.get('original_workspace_root') or fallback_workspace_root
            child_agent_id = child.get('child_agent_id')
            if not original_workspace or not child_agent_id:
                continue
            try:
                remove_worktree(original_workspace, child_agent_id)
            except Exception:
                logger.warning(
                    "清理 child worktree 失败: child_agent_id=%s (session=%s)",
                    child_agent_id, session_id, exc_info=True,
                )

    def delete_session(self, session_id: str) -> bool:
        session = self.get_session(session_id)
        if not session:
            return False

        # ── 清理 child worktree ──
        try:
            child_agents = self._conversation_store.list_child_agents(session_id=session_id, limit=self._MAX_CHILD_AGENTS_CLEANUP).get('items', [])
            workspace_root = ((session.get('metadata') or {}).get('workspace_root') or '').strip()
            self._cleanup_child_worktrees(
                session_id=session_id,
                child_agents=child_agents,
                fallback_workspace_root=workspace_root,
            )
        except Exception:
            logger.warning(
                "delete_session: 清理 child worktree 失败 (session=%s)", session_id, exc_info=True
            )

        # ── 清理 file history 备份数据 ──
        try:
            from services.file_history import remove_file_history
            remove_file_history(session_id)
        except Exception:
            logger.warning(
                "delete_session: 清理 file history 失败 (session=%s)", session_id, exc_info=True
            )

        try:
            from tools.artifacts.visualization_artifact_manager import get_visualization_artifact_manager
            removed = get_visualization_artifact_manager().delete_by_session(session_id)
            if removed:
                import logging
                logging.getLogger(__name__).info(
                    "delete_session: 已清理 %d 个可视化 artifact (session=%s)", removed, session_id
                )
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "delete_session: 清理可视化 artifact 失败 (session=%s)", session_id, exc_info=True
            )

        deleted = self._conversation_store.delete_session(session_id=session_id)

        try:
            from file_index import FileIndex
            file_index = FileIndex()
            session_files = file_index.list(scope_type='session', scope_id=session_id)
            for item in session_files:
                file_index.delete(item.get('id'))
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "delete_session: 清理 session 文件索引失败 (session=%s)", session_id, exc_info=True
            )

        try:
            import shutil
            from core.path_resolution import get_session_cleanup_root
            cleanup_root = get_session_cleanup_root(session_id)
            if cleanup_root.exists():
                shutil.rmtree(cleanup_root, ignore_errors=True)
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "delete_session: 清理 session 文件树失败 (session=%s)", session_id, exc_info=True
            )
        return deleted

    def rollback_messages(
        self,
        *,
        session_id: str,
        after_seq: Optional[int] = None,
        after_message_id: Optional[str] = None,
    ) -> int:
        # ── 文件回退 ──
        file_reverted = self._rollback_file_snapshot(session_id, after_seq, after_message_id)
        if not file_reverted:
            logger.debug("rollback_messages: 文件回退未执行 (session=%s)", session_id)

        # ── child worktree 清理（仅 after_seq 路径：created_seq 比对需要整数 seq） ──
        rollback_children = []
        if after_seq is not None:
            rollback_children = self._conversation_store.list_child_agents(session_id=session_id, limit=self._MAX_CHILD_AGENTS_CLEANUP).get('items', [])
            rollback_children = [
                item for item in rollback_children
                if item.get('created_seq') is not None and item.get('created_seq') > after_seq
            ]
            if rollback_children:
                session = self.get_session(session_id) or {}
                workspace_root = ((session.get('metadata') or {}).get('workspace_root') or '').strip()
                try:
                    self._cleanup_child_worktrees(
                        session_id=session_id,
                        child_agents=rollback_children,
                        fallback_workspace_root=workspace_root,
                    )
                except Exception:
                    logger.warning(
                        "rollback_messages: 清理 child worktree 失败 (session=%s)", session_id, exc_info=True
                    )

        # ── 消息回退 ──
        return self._conversation_store.delete_messages_after(
            session_id=session_id,
            after_seq=after_seq,
            after_message_id=after_message_id,
        )

    def _resolve_snapshot_anchor_user_message(
        self,
        session_id: str,
        after_seq: Optional[int],
        after_message_id: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        """把 rollback 锚点解析成用于文件恢复的 user 消息。"""
        target_message = None
        if after_seq is not None:
            target_message = self._conversation_store.get_message_by_seq(session_id=session_id, seq=after_seq)
        elif after_message_id:
            with self._conversation_store._get_connection() as conn:
                row = conn.execute(
                    """
                    SELECT seq, id, role, content, metadata, thread_key, child_agent_id, created_at
                    FROM messages
                    WHERE session_id=? AND id=?
                    """,
                    (session_id, after_message_id),
                ).fetchone()
                if row:
                    import json
                    target_message = {
                        "seq": row["seq"],
                        "id": row["id"],
                        "role": row["role"],
                        "content": row["content"],
                        "metadata": json.loads(row["metadata"] or "{}"),
                        "thread_key": row["thread_key"],
                        "child_agent_id": row["child_agent_id"],
                        "created_at": row["created_at"],
                    }

        # after_seq 在该会话中不存在（全局 AUTOINCREMENT 导致 seq 不连续），
        # 向后搜索该会话中最近的一条消息作为起点。
        if not target_message and after_seq is not None:
            with self._conversation_store._get_connection() as conn:
                row = conn.execute(
                    """
                    SELECT seq, id, role, content, metadata, thread_key, child_agent_id, created_at
                    FROM messages
                    WHERE session_id=? AND seq>?
                    ORDER BY seq ASC
                    LIMIT 1
                    """,
                    (session_id, after_seq),
                ).fetchone()
                if row:
                    import json
                    target_message = {
                        "seq": row["seq"],
                        "id": row["id"],
                        "role": row["role"],
                        "content": row["content"],
                        "metadata": json.loads(row["metadata"] or "{}"),
                        "thread_key": row["thread_key"],
                        "child_agent_id": row["child_agent_id"],
                        "created_at": row["created_at"],
                    }

        if not target_message:
            return None

        if target_message.get("role") == "user":
            return target_message

        target_seq = target_message.get("seq")
        if target_seq is None:
            return None

        # assistant 锚点：优先折算到后一个可见 root user。
        # 因为该 user 的 snapshot_commit 表示“assistant 执行完成后、该 user 执行开始前”的文件状态。
        with self._conversation_store._get_connection() as conn:
            rows = conn.execute(
                """
                SELECT seq, id, role, content, metadata, thread_key, child_agent_id, created_at
                FROM messages
                WHERE session_id=? AND seq>?
                ORDER BY seq ASC
                LIMIT 20
                """,
                (session_id, target_seq),
            ).fetchall()
            import json
            for row in rows:
                metadata = json.loads(row["metadata"] or "{}")
                if row["role"] != "user":
                    continue
                if row["thread_key"] not in (None, "", "root"):
                    continue
                if row["child_agent_id"] is not None:
                    continue
                if metadata.get("visible_to_user") is False:
                    continue
                if metadata.get("conversation_scope") == "child":
                    continue
                return {
                    "seq": row["seq"],
                    "id": row["id"],
                    "role": row["role"],
                    "content": row["content"],
                    "metadata": metadata,
                    "thread_key": row["thread_key"],
                    "child_agent_id": row["child_agent_id"],
                    "created_at": row["created_at"],
                }

        # 若没有后一个 user，则回退到前一个 user 作为保底。
        with self._conversation_store._get_connection() as conn:
            rows = conn.execute(
                """
                SELECT seq, id, role, content, metadata, thread_key, child_agent_id, created_at
                FROM messages
                WHERE session_id=? AND seq<=?
                ORDER BY seq DESC
                LIMIT 20
                """,
                (session_id, target_seq),
            ).fetchall()
            import json
            for row in rows:
                metadata = json.loads(row["metadata"] or "{}")
                if row["role"] != "user":
                    continue
                if row["thread_key"] not in (None, "", "root"):
                    continue
                if row["child_agent_id"] is not None:
                    continue
                if metadata.get("visible_to_user") is False:
                    continue
                if metadata.get("conversation_scope") == "child":
                    continue
                return {
                    "seq": row["seq"],
                    "id": row["id"],
                    "role": row["role"],
                    "content": row["content"],
                    "metadata": metadata,
                    "thread_key": row["thread_key"],
                    "child_agent_id": row["child_agent_id"],
                    "created_at": row["created_at"],
                }
        return None

    def _rollback_file_snapshot(
        self,
        session_id: str,
        after_seq: Optional[int],
        after_message_id: Optional[str],
    ) -> bool:
        """根据回退位置，使用 file history 恢复文件。返回是否成功。"""
        try:
            from services.file_history import get_file_history
            fh = get_file_history(session_id)
            if not fh.has_snapshots():
                logger.debug("文件回退跳过: 无快照记录 (session=%s)", session_id)
                return False

            target_user_message = self._resolve_snapshot_anchor_user_message(
                session_id=session_id,
                after_seq=after_seq,
                after_message_id=after_message_id,
            )
            if not target_user_message:
                logger.debug(
                    "文件回退跳过: 未找到锚点用户消息 (session=%s after_seq=%s after_message_id=%s)",
                    session_id, after_seq, after_message_id,
                )
                return False

            target_seq = target_user_message.get("seq")
            if target_seq is None:
                logger.debug("文件回退跳过: 锚点消息无 seq (session=%s)", session_id)
                return False

            result = fh.rewind(target_seq)
            if result.get("success"):
                logger.info(
                    "对话回退自动恢复文件: session=%s target_seq=%s reverted=%s",
                    session_id, target_seq, result.get("reverted_files"),
                )
                return True

            logger.warning(
                "文件回退 rewind 失败: session=%s reason=%s",
                session_id, result.get("message"),
            )
            return False
        except Exception:
            logger.warning(
                "对话回退文件恢复异常: session=%s", session_id, exc_info=True,
            )
            return False

    def prepare_retry(
        self,
        *,
        session_id: str,
        after_seq: int,
        modify_user_message: Optional[str] = None,
    ) -> Dict[str, Any]:
        original_message = self._conversation_store.get_message_by_seq(session_id=session_id, seq=after_seq)
        if not original_message:
            raise ValueError(f'未找到会话 {session_id} 中序号为 {after_seq} 的消息')
        if original_message.get('role') != 'user':
            raise ValueError('指定位置必须是用户消息（user），才能从此处重试')

        # 如果修改了用户消息，需要重新绑定当前 file history snapshot
        if modify_user_message is not None:
            try:
                from services.file_history import get_file_history
                fh = get_file_history(session_id)
                snapshot_id = fh.make_snapshot(after_seq)
                metadata = dict(original_message.get('metadata') or {})
                if snapshot_id:
                    metadata['snapshot_id'] = snapshot_id
                self._conversation_store.update_message(
                    message_id=original_message['id'],
                    content=(modify_user_message or '').strip() or original_message.get('content') or '',
                    metadata=metadata,
                    session_id=session_id,
                    role_filter='user',
                )
                original_message['metadata'] = metadata
                original_message['content'] = (modify_user_message or '').strip() or original_message.get('content') or ''
            except Exception:
                logger.debug("prepare_retry: file history snapshot 失败", exc_info=True)

        deleted = self.rollback_messages(session_id=session_id, after_seq=after_seq)
        task = (modify_user_message or '').strip() or (original_message.get('content') or '').strip()
        if not task:
            raise ValueError('无法获取要重试的任务内容')

        return {
            'deleted': deleted,
            'task': task,
            'message': original_message,
        }

    def update_user_message(self, *, session_id: str, message_id: str, content: str) -> bool:
        return self._conversation_store.update_message(
            message_id=message_id,
            content=content,
            session_id=session_id,
            role_filter='user',
        )

    def list_messages(
        self,
        *,
        session_id: str,
        limit: int = 20,
        offset: int = 0,
        expand_steps: bool = False,
    ) -> Dict[str, Any]:
        data = self._conversation_store.list_messages(session_id=session_id, limit=limit, offset=offset)
        if data.get('items'):
            visible_items = []
            for item in data['items']:
                metadata = item.get('metadata') or {}
                if metadata.get('react_intermediate'):
                    continue
                if metadata.get('visible_to_user') is False:
                    continue
                if metadata.get('conversation_scope') == 'child':
                    continue
                if item.get('thread_key') not in (None, '', 'root'):
                    continue
                if item.get('role') == 'assistant':
                    item['has_execution'] = bool(metadata.get('run_id'))
                visible_items.append(item)
            data['items'] = visible_items
        if expand_steps and data.get('items'):
            for item in data['items']:
                metadata = item.get('metadata') or {}
                run_id = metadata.get('run_id')
                if item.get('role') != 'assistant' or not run_id:
                    continue
                raw_steps = self._conversation_store.list_run_steps(
                    run_id=run_id,
                    session_id=session_id,
                    limit=500,
                )
                item['execution_steps'] = [
                    self._compact_execution_step(step.get('payload') or {})
                    for step in raw_steps
                    if step.get('step_type') == 'execution.step'
                ]
        return data

    def list_message_run_steps(
        self,
        *,
        session_id: str,
        message_id: str,
        limit: int = 500,
        offset: int = 0,
    ) -> Dict[str, Any]:
        data = self._conversation_store.list_messages(session_id=session_id, limit=1000, offset=0)
        message = next(
            (
                item for item in (data.get('items') or [])
                if item.get('id') == message_id and self._is_visible_root_message(item)
            ),
            None,
        )
        if not message:
            raise LookupError(f'消息不存在: {message_id}')
        if message.get('role') != 'assistant':
            raise ValueError('仅 assistant 消息支持查询 execution steps')

        raw_steps = self._conversation_store.list_run_steps(
            message_id=message_id,
            session_id=session_id,
            limit=limit + offset,
        )
        execution_steps = [
            self._compact_execution_step(step.get('payload') or {})
            for step in raw_steps
            if step.get('step_type') == 'execution.step'
        ]
        items = execution_steps[offset:offset + limit]
        return {
            'message_id': message_id,
            'items': items,
            'total': len(execution_steps),
            'limit': limit,
            'offset': offset,
            'has_more': offset + limit < len(execution_steps),
        }

    def export_session(self, session_id: str) -> Dict[str, Any]:
        session = self.get_session(session_id)
        if not session:
            raise LookupError(f'会话不存在: {session_id}')

        messages = self.list_messages(
            session_id=session_id,
            limit=1000,
            offset=0,
            expand_steps=True,
        )
        if messages.get('has_more'):
            messages = self.list_messages(
                session_id=session_id,
                limit=max(int(messages.get('total') or 1000), 1000),
                offset=0,
                expand_steps=True,
            )

        items = messages.get('items') or []
        return {
            'version': 1,
            'exported_at': datetime.now(timezone.utc).isoformat(),
            'session': session,
            'messages': items,
            'message_count': len(items),
        }

    def add_assistant_message(self, *, session_id: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        self._conversation_store.add_message(
            session_id=session_id,
            role='assistant',
            content=content,
            metadata=metadata or {},
        )


def get_agent_session_application() -> AgentSessionApplication:
    return get_runtime_dependency(container_getter='get_agent_session_application')
