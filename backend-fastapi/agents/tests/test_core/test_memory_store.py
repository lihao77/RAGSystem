# -*- coding: utf-8 -*-

import shutil
import tempfile
from pathlib import Path

from services.memory_store import MemoryStore


def test_memory_store_creates_session_memory_files_and_index():
    root = Path(tempfile.mkdtemp())
    try:
        store = MemoryStore()
        original = store.get_project_root
        store.get_project_root = lambda: root

        path = store.save_memory(
            scope="session",
            session_id="session-1",
            agent_name="orchestrator_agent",
            name="用户偏好-使用中文",
            description="当前 session 中用户要求使用中文",
            memory_type="preference",
            content="后续回答默认使用中文。",
        )

        assert path.exists()
        index_path = path.parent / "MEMORY.md"
        assert index_path.exists()
        index_text = index_path.read_text(encoding="utf-8")
        assert "用户偏好-使用中文" in index_text
        assert "preference_用户偏好-使用中文.md" in index_text
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_memory_store_load_index_head_and_search_memories():
    root = Path(tempfile.mkdtemp())
    try:
        store = MemoryStore()
        store.get_project_root = lambda: root
        store.save_memory(
            scope="team",
            team_name="alpha-team",
            name="团队阶段-P1",
            description="团队当前阶段目标是落地 P1 记忆系统",
            memory_type="goal",
            content="当前阶段目标是落地 P1 记忆系统。",
        )
        store.save_memory(
            scope="session",
            session_id="session-1",
            agent_name="orchestrator_agent",
            name="用户偏好-最少代码",
            description="当前 session 中用户要求优先最少代码",
            memory_type="preference",
            content="后续方案优先最少代码。",
        )

        workspace_path = store.save_memory(
            scope="workspace",
            workspace_key="E-Python-cc-claude-code-source-code",
            name="工作区偏好-测试",
            description="工作区级测试记忆",
            memory_type="preference",
            content="工作区记忆应落在全局 workspaces 桶下。",
        )

        team_head = store.load_index_head(scope="team", team_name="alpha-team")
        session_head = store.load_index_head(scope="session", session_id="session-1")
        hits = store.search_memories(
            scope_chain=[
                {"scope": "team", "team_name": "alpha-team"},
                {"scope": "session", "session_id": "session-1"},
            ],
            query="最少代码 P1",
            limit=5,
        )

        assert "团队阶段-P1" in team_head
        assert "用户偏好-最少代码" in session_head
        assert len(hits) >= 1
        assert workspace_path == Path.home() / ".ragsystem" / "memory" / "workspaces" / "E-Python-cc-claude-code-source-code" / "preference_工作区偏好-测试.md"
    finally:
        shutil.rmtree(root, ignore_errors=True)
