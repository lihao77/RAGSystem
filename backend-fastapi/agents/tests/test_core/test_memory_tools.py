# -*- coding: utf-8 -*-

import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

from hooks.builtin.tool_hooks import handle_memory_write_guard
from hooks.models import HookContext
from services.memory_store import MemoryStore
from tools.local.memory_tools import archive_memory, list_memory_index, read_memory_entry, write_memory
from tools.runtime.executor import _run_hooks_sync
from tools.runtime.models import ToolUseContext


def test_memory_tools_list_read_write_and_archive(monkeypatch):
    root = Path(tempfile.mkdtemp())
    try:
        store = MemoryStore(project_key="demo-project")
        store.get_project_root = lambda: root / "projects" / "demo-project"
        monkeypatch.setattr('tools.local.memory_tools._MEMORY_STORE', store)
        monkeypatch.setattr(
            'tools.local.memory_tools.get_config_manager',
            lambda: SimpleNamespace(get_config=lambda name: SimpleNamespace(memory=SimpleNamespace(allowed_scopes=['project', 'session'], write_scopes=['session'], archive_scopes=['session']))),
        )

        write_result = write_memory(
            scope='session',
            session_id='session-1',
            agent_name='orchestrator_agent',
            current_agent_name='orchestrator_agent',
            name='用户偏好-使用中文',
            description='当前 session 中用户要求使用中文',
            memory_type='preference',
            content='后续回答默认使用中文。',
        )
        assert write_result.success is True
        file_name = write_result.content['file_name']

        index_result = list_memory_index(scope='session', session_id='session-1', current_agent_name='orchestrator_agent')
        assert index_result.success is True
        assert '用户偏好-使用中文' in index_result.content

        read_result = read_memory_entry(scope='session', session_id='session-1', file_name=file_name, current_agent_name='orchestrator_agent')
        assert read_result.success is True
        assert '后续回答默认使用中文。' in read_result.content

        archive_result = archive_memory(scope='session', session_id='session-1', file_name=file_name, current_agent_name='orchestrator_agent')
        assert archive_result.success is True

        index_after_archive = list_memory_index(scope='session', session_id='session-1', current_agent_name='orchestrator_agent')
        assert '用户偏好-使用中文' not in index_after_archive.content
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_memory_write_guard_uses_runtime_injected_session_id():
    context = HookContext(
        event_name="tool.before_execute",
        phase="before_execute",
        timestamp=0.0,
        tool_name="write_memory",
        session_id="session-1",
        input_snapshot={
            "scope": "session",
            "memory_type": "preference",
            "name": "用户偏好-使用中文",
            "session_id": "session-1",
        },
    )

    result = handle_memory_write_guard(context, {})

    assert result.additional_context == [
        "Writing to memory: scope=session, type=preference, name=用户偏好-使用中文",
        "This will persist across conversations.",
        "Bound to session_id=session-1",
    ]


def test_run_hooks_sync_exposes_runtime_injected_handler_arguments(monkeypatch):
    captured = {}

    async def fake_run_hooks(hook_context):
        captured["input_snapshot"] = dict(hook_context.input_snapshot)
        return None

    monkeypatch.setattr("hooks.executor.run_hooks", fake_run_hooks)
    monkeypatch.setattr("hooks.config_loader.resolve_workspace_trust", lambda workspace_root: "trusted")
    monkeypatch.setattr("tools.permission_manager.get_permission_policy", lambda: SimpleNamespace(mode=SimpleNamespace(value="default")))
    monkeypatch.setattr("tools.permissions.get_tool_permission", lambda tool_name: SimpleNamespace(risk_level=SimpleNamespace(value="low")))
    monkeypatch.setattr("tools.runtime.executor.get_tool_handler", lambda tool_name: write_memory)

    context = ToolUseContext(
        tool_name="write_memory",
        arguments={
            "scope": "session",
            "name": "用户偏好-使用中文",
            "description": "当前 session 中用户要求使用中文",
            "memory_type": "preference",
            "content": "后续回答默认使用中文。",
        },
        caller="direct",
        session_id="session-1",
        current_agent_name="orchestrator_agent",
    )

    _run_hooks_sync("tool.before_execute", context)

    assert captured["input_snapshot"]["session_id"] == "session-1"
    assert captured["input_snapshot"]["memory_type"] == "preference"
