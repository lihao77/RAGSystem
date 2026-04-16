# -*- coding: utf-8 -*-
"""Agent session use cases."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from services.conversation_store import ConversationStore
from runtime.dependencies import get_runtime_dependency

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
        metadata = metadata or {}
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

    def delete_session(self, session_id: str) -> bool:
        session = self.get_session(session_id)
        if not session:
            return False

        # ── 清理 snapshot 元数据 ──
        try:
            from utils.worktree import snapshot_enabled, cleanup_snapshot
            if snapshot_enabled(session_id):
                cleanup_snapshot(session_id)
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "delete_session: 清理 snapshot 失败 (session=%s)", session_id, exc_info=True
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
        self._rollback_file_snapshot(session_id, after_seq, after_message_id)

        # ── 消息回退 ──
        return self._conversation_store.delete_messages_after(
            session_id=session_id,
            after_seq=after_seq,
            after_message_id=after_message_id,
        )

    def _rollback_file_snapshot(
        self,
        session_id: str,
        after_seq: Optional[int],
        after_message_id: Optional[str],
    ):
        """根据回退位置，自动恢复文件到对应 snapshot。"""
        try:
            from utils.worktree import snapshot_enabled, get_snapshot_workspace, find_snapshot_by_run_id, rewind_to_snapshot

            if not snapshot_enabled(session_id):
                return

            workspace = get_snapshot_workspace(session_id)
            if not workspace:
                return

            # 解析 after_seq
            resolved_seq = after_seq
            if resolved_seq is None and after_message_id:
                # 通过 message_id 查找 seq
                with self._conversation_store._get_connection() as conn:
                    row = conn.execute(
                        "SELECT seq FROM messages WHERE session_id=? AND id=?",
                        (session_id, after_message_id),
                    ).fetchone()
                    if row:
                        resolved_seq = row["seq"]
            if resolved_seq is None:
                return

            # 找到 seq<=resolved_seq 中最后一个有 run_id 的 assistant 消息
            target_run_id = self._conversation_store.find_last_run_id_before_seq(
                session_id, resolved_seq
            )
            if not target_run_id:
                return

            # 在 git log 中查找对应 commit
            commit_hash = find_snapshot_by_run_id(workspace, target_run_id)
            if not commit_hash:
                return

            # 执行回退
            rewind_to_snapshot(workspace, commit_hash)
            logger.info(
                "对话回退自动恢复文件: session=%s run_id=%s commit=%s",
                session_id, target_run_id, commit_hash[:8],
            )
        except Exception:
            logger.warning(
                "对话回退文件恢复失败: session=%s", session_id, exc_info=True,
            )

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

        deleted = self.rollback_messages(session_id=session_id, after_seq=after_seq)
        task = (modify_user_message or '').strip() or (original_message.get('content') or '').strip()
        if not task:
            raise ValueError('无法获取要重试的任务内容')

        if modify_user_message is not None:
            self._conversation_store.update_message(
                message_id=original_message['id'],
                content=task,
                session_id=session_id,
                role_filter='user',
            )

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
