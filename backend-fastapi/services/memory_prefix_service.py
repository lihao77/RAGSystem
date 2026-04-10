# -*- coding: utf-8 -*-
"""Memory stable prefix 构建、持久化与刷新服务。"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class MemoryPrefixHandle:
    service: "MemoryPrefixService"
    session_id: str
    thread_key: str
    agent_name: Optional[str]

    def get_current_fingerprint(self) -> Optional[Dict[str, Any]]:
        return self.service.get_current_fingerprint(
            session_id=self.session_id,
            agent_name=self.agent_name,
        )

    def refresh_snapshot(
        self,
        *,
        reason: str = 'runtime_refresh',
        force_rebuild: bool = False,
    ) -> Optional[Dict[str, Any]]:
        return self.service.refresh_snapshot(
            session_id=self.session_id,
            thread_key=self.thread_key,
            agent_name=self.agent_name,
            rebased_reason=reason,
            force_rebuild=force_rebuild,
        )


class MemoryPrefixService:
    """管理 memory stable prefix snapshot 与 fingerprint。"""

    def __init__(
        self,
        *,
        conversation_store,
        memory_store,
        resolve_agent_config_for_session: Callable[[Optional[str], Optional[str]], Any],
        get_session_team: Callable[[Optional[str]], Optional[str]],
        get_memory_workspace_key: Callable[[Optional[str]], Optional[str]],
    ):
        self._conversation_store = conversation_store
        self._memory_store = memory_store
        self._resolve_agent_config_for_session = resolve_agent_config_for_session
        self._get_session_team = get_session_team
        self._get_memory_workspace_key = get_memory_workspace_key

    @staticmethod
    def _memory_baseline_key(thread_key: str, agent_name: Optional[str]) -> str:
        resolved_thread_key = (thread_key or 'root').strip() or 'root'
        resolved_agent_name = (agent_name or '').strip() or '_anonymous_'
        return f"{resolved_thread_key}::{resolved_agent_name}"

    def _build_memory_scope_specs(self, *, memory_config, session_id: str, agent_name: Optional[str]):
        allowed_scopes = set(getattr(memory_config, 'allowed_scopes', None) or [])
        workspace_key = self._get_memory_workspace_key(session_id)
        team_name = self._get_session_team(session_id)
        scope_specs = []
        if 'team' in allowed_scopes and team_name:
            scope_specs.append(('team', {'scope': 'team', 'team_name': team_name}))
        if 'session' in allowed_scopes:
            scope_specs.append(('session', {'scope': 'session', 'session_id': session_id}))
        if 'agent' in allowed_scopes and agent_name and team_name:
            scope_specs.append(('agent', {'scope': 'agent', 'agent_name': agent_name, 'team_name': team_name}))
        if 'workspace' in allowed_scopes and workspace_key:
            scope_specs.append(('workspace', {'scope': 'workspace', 'workspace_key': workspace_key}))
        return scope_specs

    @staticmethod
    def _build_memory_scope_capabilities(memory_config) -> Dict[str, List[str]]:
        if not memory_config or getattr(memory_config, 'enabled', True) is False:
            return {
                'allowed_scopes': [],
                'write_scopes': [],
                'archive_scopes': [],
            }
        return {
            'allowed_scopes': list(getattr(memory_config, 'allowed_scopes', []) or []),
            'write_scopes': list(getattr(memory_config, 'write_scopes', []) or []),
            'archive_scopes': list(getattr(memory_config, 'archive_scopes', []) or []),
        }

    def _build_memory_prefix_fingerprint(
        self,
        *,
        memory_config,
        scope_specs: List[tuple[str, Dict[str, Any]]],
        agent_name: Optional[str],
    ) -> Dict[str, Any]:
        capabilities = self._build_memory_scope_capabilities(memory_config)
        payload = {
            'agent_name': (agent_name or '').strip() or None,
            'auto_inject': bool(getattr(memory_config, 'auto_inject', True)),
            'allowed_scopes': sorted(capabilities['allowed_scopes']),
            'write_scopes': sorted(capabilities['write_scopes']),
            'archive_scopes': sorted(capabilities['archive_scopes']),
            'scope_specs': [
                {
                    'scope_name': scope_name,
                    'scope_spec': dict(scope_spec),
                }
                for scope_name, scope_spec in scope_specs
            ],
        }
        serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        payload['fingerprint'] = hashlib.sha256(serialized.encode('utf-8')).hexdigest()[:16]
        return payload

    @staticmethod
    def _render_memory_prefix_block(
        *,
        scope_capabilities: Dict[str, List[str]],
        indices: Dict[str, str],
    ) -> str:
        sections: list[str] = []
        allowed_scopes = scope_capabilities.get('allowed_scopes') or []
        write_scopes = scope_capabilities.get('write_scopes') or []
        archive_scopes = scope_capabilities.get('archive_scopes') or []
        if allowed_scopes or write_scopes or archive_scopes:
            sections.append(
                "[Memory Scope Capabilities]\n"
                f"- 可读取 scope: {', '.join(allowed_scopes) if allowed_scopes else '无'}\n"
                f"- 可写入 scope: {', '.join(write_scopes) if write_scopes else '无'}\n"
                f"- 可归档 scope: {', '.join(archive_scopes) if archive_scopes else '无'}\n"
                "- 执行 memory 工具前，必须先确认目标 scope 在对应权限列表内，避免误操作"
            )

        scope_titles = {
            'team': 'Team',
            'session': 'Session',
            'agent': 'Agent',
            'workspace': 'Workspace',
        }
        for scope_name, content in indices.items():
            if not content:
                continue
            title = scope_titles.get(scope_name, str(scope_name).replace('_', ' ').title())
            sections.append(f"[{title} Memory Index]\n" + str(content).strip())
        return "\n\n".join(sections)

    def _build_memory_prefix_snapshot(
        self,
        *,
        session_id: str,
        thread_key: str,
        agent_name: Optional[str],
        memory_config,
        fingerprint_payload: Dict[str, Any],
        scope_specs: List[tuple[str, Dict[str, Any]]],
        rebased_reason: str,
    ) -> Dict[str, Any]:
        scope_capabilities = self._build_memory_scope_capabilities(memory_config)
        indices: Dict[str, str] = {}
        if bool(getattr(memory_config, 'auto_inject', True)):
            for scope_name, scope_spec in scope_specs:
                content = self._memory_store.load_index_head(**scope_spec)
                if content:
                    indices[scope_name] = content
        rendered_block = self._render_memory_prefix_block(
            scope_capabilities=scope_capabilities,
            indices=indices,
        )
        return {
            'baseline_key': self._memory_baseline_key(thread_key, agent_name),
            'session_id': session_id,
            'thread_key': (thread_key or 'root').strip() or 'root',
            'agent_name': (agent_name or '').strip() or None,
            'fingerprint': fingerprint_payload,
            'scope_capabilities': scope_capabilities,
            'indices': indices,
            'rendered_block': rendered_block,
            'rebased_reason': rebased_reason,
        }

    def _get_session_metadata(self, session_id: str) -> Dict[str, Any]:
        session = self._conversation_store.get_session(session_id) or {}
        return dict(session.get('metadata') or {})

    def _read_memory_prefix_state(self, session_id: str, baseline_key: str) -> Optional[Dict[str, Any]]:
        metadata = self._get_session_metadata(session_id)
        states = metadata.get('memory_prefix_states') or {}
        state = states.get(baseline_key)
        return dict(state) if isinstance(state, dict) else None

    def _persist_memory_prefix_state(self, session_id: str, baseline_key: str, state: Dict[str, Any]) -> None:
        updater = getattr(self._conversation_store, 'update_session_metadata', None)
        if not callable(updater):
            logger.debug('conversation_store 不支持 update_session_metadata，跳过 memory_prefix_state 持久化')
            return
        updater(
            session_id,
            {
                'memory_prefix_states': {
                    baseline_key: state,
                }
            },
            merge_nested=True,
        )

    def _load_or_create_memory_prefix_snapshot(
        self,
        *,
        session_id: str,
        thread_key: str,
        agent_name: Optional[str],
        memory_config,
        rebased_reason: str,
        force_rebuild: bool = False,
    ) -> Optional[Dict[str, Any]]:
        if not memory_config or getattr(memory_config, 'enabled', True) is False:
            return None
        capabilities = self._build_memory_scope_capabilities(memory_config)
        memory_enabled = bool(
            capabilities['allowed_scopes']
            or capabilities['write_scopes']
            or capabilities['archive_scopes']
        )
        if not memory_enabled and getattr(memory_config, 'auto_inject', True) is False:
            return None

        scope_specs = self._build_memory_scope_specs(
            memory_config=memory_config,
            session_id=session_id,
            agent_name=agent_name,
        )
        fingerprint_payload = self._build_memory_prefix_fingerprint(
            memory_config=memory_config,
            scope_specs=scope_specs,
            agent_name=agent_name,
        )
        baseline_key = self._memory_baseline_key(thread_key, agent_name)
        existing = self._read_memory_prefix_state(session_id, baseline_key)
        if not force_rebuild and isinstance(existing, dict):
            existing_fingerprint = (existing.get('fingerprint') or {}).get('fingerprint')
            if existing_fingerprint and existing_fingerprint == fingerprint_payload['fingerprint']:
                return existing

        snapshot = self._build_memory_prefix_snapshot(
            session_id=session_id,
            thread_key=thread_key,
            agent_name=agent_name,
            memory_config=memory_config,
            fingerprint_payload=fingerprint_payload,
            scope_specs=scope_specs,
            rebased_reason=rebased_reason,
        )
        self._persist_memory_prefix_state(session_id, baseline_key, snapshot)
        return snapshot

    def get_current_fingerprint(
        self,
        *,
        session_id: str,
        agent_name: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        agent_config = self._resolve_agent_config_for_session(session_id, agent_name) if agent_name else None
        memory_config = getattr(agent_config, 'memory', None) if agent_config else None
        if not memory_config or getattr(memory_config, 'enabled', True) is False:
            return None
        scope_specs = self._build_memory_scope_specs(
            memory_config=memory_config,
            session_id=session_id,
            agent_name=agent_name,
        )
        return self._build_memory_prefix_fingerprint(
            memory_config=memory_config,
            scope_specs=scope_specs,
            agent_name=agent_name,
        )

    def refresh_snapshot(
        self,
        *,
        session_id: str,
        thread_key: str,
        agent_name: Optional[str],
        rebased_reason: str,
        force_rebuild: bool = False,
    ) -> Optional[Dict[str, Any]]:
        baseline_key = self._memory_baseline_key(thread_key, agent_name)
        agent_config = self._resolve_agent_config_for_session(session_id, agent_name) if agent_name else None
        memory_config = getattr(agent_config, 'memory', None) if agent_config else None
        snapshot = self._load_or_create_memory_prefix_snapshot(
            session_id=session_id,
            thread_key=thread_key,
            agent_name=agent_name,
            memory_config=memory_config,
            rebased_reason=rebased_reason,
            force_rebuild=force_rebuild,
        )
        if snapshot is None:
            updater = getattr(self._conversation_store, 'update_session_metadata', None)
            if callable(updater):
                updater(
                    session_id,
                    {'memory_prefix_states': {baseline_key: None}},
                    merge_nested=True,
                )
        return snapshot

    def create_handle(
        self,
        *,
        session_id: str,
        thread_key: str,
        agent_name: Optional[str],
    ) -> MemoryPrefixHandle:
        return MemoryPrefixHandle(
            service=self,
            session_id=session_id,
            thread_key=(thread_key or 'root').strip() or 'root',
            agent_name=agent_name,
        )
