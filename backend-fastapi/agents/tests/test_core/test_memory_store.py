# -*- coding: utf-8 -*-

import shutil
import tempfile
from pathlib import Path

from services.memory_store import MemoryStore


def test_memory_store_creates_session_memory_files_and_index():
    root = Path(tempfile.mkdtemp())
    try:
        store = MemoryStore(project_key="demo-project")
        original = store.get_project_root
        store.get_project_root = lambda: root / "projects" / "demo-project"

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
        store = MemoryStore(project_key="demo-project")
        store.get_project_root = lambda: root / "projects" / "demo-project"
        store.save_memory(
            scope="project",
            name="项目阶段-P1",
            description="项目当前阶段目标是落地 P1 记忆系统",
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

        project_head = store.load_index_head(scope="project")
        session_head = store.load_index_head(scope="session", session_id="session-1")
        hits = store.search_memories(
            scope_chain=[
                {"scope": "project"},
                {"scope": "session", "session_id": "session-1"},
            ],
            query="最少代码 P1",
            limit=5,
        )

        assert "项目阶段-P1" in project_head
        assert "用户偏好-最少代码" in session_head
        assert len(hits) >= 1
    finally:
        shutil.rmtree(root, ignore_errors=True)
