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
        store = MemoryStore()
        store.get_project_root = lambda: root
        monkeypatch.setattr('tools.local.memory_tools._MEMORY_STORE', store)
        monkeypatch.setattr(
            'tools.local.memory_tools.get_config_manager',
            lambda: SimpleNamespace(get_config=lambda name: SimpleNamespace(memory=SimpleNamespace(allowed_scopes=['team', 'session'], write_scopes=['session'], archive_scopes=['session']))),
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


def test_memory_tools_archive_team_memory_with_runtime_team_context(monkeypatch):
    root = Path(tempfile.mkdtemp())
    try:
        store = MemoryStore()
        store.get_project_root = lambda: root
        monkeypatch.setattr('tools.local.memory_tools._MEMORY_STORE', store)
        monkeypatch.setattr(
            'tools.local.memory_tools.get_config_manager',
            lambda: SimpleNamespace(get_config=lambda name: SimpleNamespace(memory=SimpleNamespace(allowed_scopes=['team'], write_scopes=['team'], archive_scopes=['team']))),
        )

        write_result = write_memory(
            scope='team',
            current_agent_name='orchestrator_agent',
            team_name='alpha-team',
            name='test_memory',
            description='团队测试记忆',
            memory_type='fact',
            content='团队级测试记忆。',
        )
        assert write_result.success is True

        archive_result = archive_memory(
            scope='team',
            file_name=write_result.content['file_name'],
            current_agent_name='orchestrator_agent',
            team_name='alpha-team',
        )
        assert archive_result.success is True
    finally:
        shutil.rmtree(root, ignore_errors=True)


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


def test_memory_tools_resolve_agent_and_workspace_from_runtime_context(monkeypatch):
    captured = []

    store = SimpleNamespace(
        ensure_scope=lambda **kwargs: captured.append(("ensure", kwargs)) or Path("E:/tmp/memory"),
        get_index_path=lambda scope_root: Path("E:/tmp/memory/MEMORY.md"),
        load_index_head=lambda **kwargs: captured.append(("load", kwargs)) or "# Workspace Memory\n",
    )
    monkeypatch.setattr('tools.local.memory_tools._MEMORY_STORE', store)
    monkeypatch.setattr(
        'tools.local.memory_tools.get_config_manager',
        lambda: SimpleNamespace(get_config=lambda name: SimpleNamespace(memory=SimpleNamespace(allowed_scopes=['team', 'session', 'agent', 'workspace'], write_scopes=['agent', 'workspace'], archive_scopes=['workspace']))),
    )

    index_result = list_memory_index(
        scope='agent',
        current_agent_name='orchestrator_agent',
        team_name='alpha-team',
    )
    assert index_result.success is True
    assert captured[0][1]['agent_name'] == 'orchestrator_agent'
    assert captured[0][1]['team_name'] == 'alpha-team'

    captured.clear()
    index_result = list_memory_index(
        scope='workspace',
        current_agent_name='orchestrator_agent',
        workspace_root='E:/Python/RAGSystem/workspaces/demo-workspace',
    )
    assert index_result.success is True
    assert captured[0][1]['workspace_key'] == 'E-Python-RAGSystem-workspaces-demo-workspace'

    captured.clear()
    index_result = list_memory_index(
        scope='workspace',
        current_agent_name='orchestrator_agent',
        session_id='session-1',
        workspace_root='C:/Users/admin/.ragsystem/sessions/session-1/workspace',
    )
    assert index_result.success is True
    assert captured[0][1]['workspace_key'] == 'C-Users-admin-.ragsystem-sessions-session-1-workspace'
