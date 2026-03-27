# -*- coding: utf-8 -*-
"""Markdown-based memory store aligned with Claude Code style."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional

from tools.paths.path_resolution import BACKEND_ROOT, get_memory_project_root, get_project_memory_scope_root, get_session_memory_scope_root


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)
_ALLOWED_MEMORY_TYPES = {"preference", "constraint", "goal", "fact", "profile"}
_ALLOWED_SCOPES = {"project", "session", "agent", "workspace"}


@dataclass
class MemoryEntry:
    name: str
    description: str
    scope: str
    memory_type: str
    status: str
    file_name: str
    file_path: str
    updated_at: str
    body: str = ""


class MemoryStore:
    def __init__(self, *, project_key: Optional[str] = None):
        self.project_key = (project_key or BACKEND_ROOT.name).strip() or BACKEND_ROOT.name

    def get_project_root(self) -> Path:
        root = get_memory_project_root(self.project_key)
        root.mkdir(parents=True, exist_ok=True)
        return root

    def get_scope_root(
        self,
        *,
        scope: str,
        session_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        workspace_key: Optional[str] = None,
    ) -> Path:
        normalized_scope = (scope or "").strip().lower()
        if normalized_scope not in _ALLOWED_SCOPES:
            raise ValueError(f"不支持的 memory scope: {scope}")
        if normalized_scope == "project":
            return get_project_memory_scope_root(self.project_key)
        if normalized_scope == "session":
            if not (session_id or "").strip():
                raise ValueError("session scope 缺少 session_id")
            return get_session_memory_scope_root(session_id, self.project_key)
        project_root = self.get_project_root()
        if normalized_scope == "agent":
            normalized_agent = (agent_name or "").strip()
            if not normalized_agent:
                raise ValueError("agent scope 缺少 agent_name")
            return project_root / "agents" / normalized_agent
        normalized_workspace = (workspace_key or "").strip()
        if not normalized_workspace:
            raise ValueError("workspace scope 缺少 workspace_key")
        return project_root / "workspaces" / normalized_workspace

    @staticmethod
    def get_index_path(scope_root: Path) -> Path:
        return scope_root / "MEMORY.md"

    def ensure_scope(
        self,
        *,
        scope: str,
        session_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        workspace_key: Optional[str] = None,
    ) -> Path:
        scope_root = self.get_scope_root(
            scope=scope,
            session_id=session_id,
            agent_name=agent_name,
            workspace_key=workspace_key,
        )
        scope_root.mkdir(parents=True, exist_ok=True)
        index_path = self.get_index_path(scope_root)
        if not index_path.exists():
            title = f"# {scope.capitalize()} Memory"
            index_path.write_text(f"{title}\n\n", encoding="utf-8")
        return scope_root

    def load_index_head(
        self,
        *,
        scope: str,
        session_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        workspace_key: Optional[str] = None,
        max_lines: int = 200,
        max_chars: int = 25 * 1024,
    ) -> str:
        scope_root = self.ensure_scope(
            scope=scope,
            session_id=session_id,
            agent_name=agent_name,
            workspace_key=workspace_key,
        )
        text = self.get_index_path(scope_root).read_text(encoding="utf-8")
        lines = text.splitlines()
        limited = "\n".join(lines[:max_lines])
        return limited[:max_chars].strip()

    def save_memory(
        self,
        *,
        scope: str,
        name: str,
        description: str,
        memory_type: str,
        content: str,
        why: Optional[str] = None,
        how_to_apply: Optional[str] = None,
        session_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        workspace_key: Optional[str] = None,
        source_run_id: Optional[str] = None,
        source_message_id: Optional[str] = None,
        status: str = "active",
    ) -> Path:
        normalized_memory_type = (memory_type or "fact").strip().lower()
        if normalized_memory_type not in _ALLOWED_MEMORY_TYPES:
            raise ValueError(f"不支持的 memory_type: {memory_type}")
        normalized_scope = (scope or "session").strip().lower()
        scope_root = self.ensure_scope(
            scope=normalized_scope,
            session_id=session_id,
            agent_name=agent_name,
            workspace_key=workspace_key,
        )
        slug = self._slugify(name)
        file_name = f"{normalized_memory_type}_{slug}.md"
        file_path = scope_root / file_name
        now = self._now_iso()
        existing = self._read_entry(file_path) if file_path.exists() else None
        created_at = existing.updated_at if existing else now
        body_lines = [content.strip()]
        if why:
            body_lines.append("")
            body_lines.append(f"**Why:** {why.strip()}")
        if how_to_apply:
            body_lines.append(f"**How to apply:** {how_to_apply.strip()}")
        body = "\n".join(body_lines).strip() + "\n"
        frontmatter = {
            "name": name.strip(),
            "description": description.strip(),
            "type": normalized_scope,
            "memory_type": normalized_memory_type,
            "status": (status or "active").strip().lower(),
            "agent": (agent_name or "").strip(),
            "session_id": (session_id or "").strip(),
            "created_at": created_at,
            "updated_at": now,
            "source_run_id": (source_run_id or "").strip(),
            "source_message_id": (source_message_id or "").strip(),
        }
        file_path.write_text(self._render_markdown(frontmatter, body), encoding="utf-8")
        self._rebuild_index(scope_root, normalized_scope)
        return file_path

    def list_entries(
        self,
        *,
        scope: str,
        session_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        workspace_key: Optional[str] = None,
        include_archived: bool = False,
    ) -> List[MemoryEntry]:
        scope_root = self.ensure_scope(
            scope=scope,
            session_id=session_id,
            agent_name=agent_name,
            workspace_key=workspace_key,
        )
        entries: list[MemoryEntry] = []
        for file_path in sorted(scope_root.glob("*.md")):
            if file_path.name == "MEMORY.md":
                continue
            entry = self._read_entry(file_path)
            if entry is None:
                continue
            if not include_archived and entry.status != "active":
                continue
            entries.append(entry)
        entries.sort(key=lambda item: item.updated_at, reverse=True)
        return entries

    def archive_memory(
        self,
        *,
        scope: str,
        file_name: str,
        session_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        workspace_key: Optional[str] = None,
    ) -> bool:
        scope_root = self.ensure_scope(
            scope=scope,
            session_id=session_id,
            agent_name=agent_name,
            workspace_key=workspace_key,
        )
        file_path = scope_root / file_name
        entry = self._read_entry(file_path)
        if entry is None:
            return False
        text = file_path.read_text(encoding="utf-8")
        file_path.write_text(text.replace("status: active", "status: archived", 1), encoding="utf-8")
        self._rebuild_index(scope_root, scope)
        return True

    def search_memories(
        self,
        *,
        scope_chain: Iterable[dict],
        query: Optional[str],
        limit: int = 5,
    ) -> List[MemoryEntry]:
        keywords = [token for token in re.split(r"\s+", (query or "").strip().lower()) if token]
        scored: list[tuple[tuple[int, int, str], MemoryEntry]] = []
        for priority, scope_spec in enumerate(scope_chain):
            entries = self.list_entries(**scope_spec)
            for entry in entries:
                haystack = f"{entry.name} {entry.description} {entry.body}".lower()
                match_score = sum(1 for token in keywords if token in haystack)
                if keywords and match_score == 0:
                    continue
                scored.append(((-match_score, priority, entry.updated_at), entry))
        scored.sort(key=lambda item: item[0])
        return [entry for _, entry in scored[:limit]]

    def _rebuild_index(self, scope_root: Path, scope: str) -> None:
        entries = self.list_entries(scope=scope, session_id=scope_root.name if scope == "session" else None, agent_name=scope_root.name if scope == "agent" else None, workspace_key=scope_root.name if scope == "workspace" else None, include_archived=False)
        title = f"# {scope.capitalize()} Memory"
        lines = [title, ""]
        if entries:
            lines.append("## Index")
            lines.append("")
            for entry in entries:
                lines.append(f"- [{entry.name}]({entry.file_name}) - {entry.description}")
        else:
            lines.append("暂无记忆。")
        self.get_index_path(scope_root).write_text("\n".join(lines).strip() + "\n", encoding="utf-8")

    @staticmethod
    def _slugify(value: str) -> str:
        slug = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff._-]+", "-", value.strip()).strip("-._")
        return slug or "memory"

    @staticmethod
    def _render_markdown(frontmatter: dict, body: str) -> str:
        lines = ["---"]
        for key, value in frontmatter.items():
            lines.append(f"{key}: {value}")
        lines.append("---")
        lines.append("")
        lines.append(body.rstrip())
        lines.append("")
        return "\n".join(lines)

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _read_entry(file_path: Path) -> Optional[MemoryEntry]:
        if not file_path.exists() or file_path.name == "MEMORY.md":
            return None
        text = file_path.read_text(encoding="utf-8")
        match = _FRONTMATTER_RE.match(text)
        if not match:
            return None
        frontmatter_raw, body = match.groups()
        metadata: dict[str, str] = {}
        for line in frontmatter_raw.splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            metadata[key.strip()] = value.strip()
        return MemoryEntry(
            name=metadata.get("name", file_path.stem),
            description=metadata.get("description", ""),
            scope=metadata.get("type", "session"),
            memory_type=metadata.get("memory_type", "fact"),
            status=metadata.get("status", "active"),
            file_name=file_path.name,
            file_path=str(file_path),
            updated_at=metadata.get("updated_at", ""),
            body=body.strip(),
        )
