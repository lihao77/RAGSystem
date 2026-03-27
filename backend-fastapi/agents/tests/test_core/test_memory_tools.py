# -*- coding: utf-8 -*-

import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

from services.memory_store import MemoryStore
from tools.local.memory_tools import archive_memory, list_memory_index, read_memory_entry, write_memory


def test_memory_tools_list_read_write_and_archive(monkeypatch):
    root = Path(tempfile.mkdtemp())
    try:
        store = MemoryStore(project_key="demo-project")
        store.get_project_root = lambda: root / "projects" / "demo-project"
        monkeypatch.setattr('tools.local.memory_tools._MEMORY_STORE', store)
        monkeypatch.setattr(
            'tools.local.memory_tools.get_config_manager',
            lambda: SimpleNamespace(get_config=lambda name: SimpleNamespace(memory=SimpleNamespace(enabled=True, enabled_tools=[], allowed_scopes=['project', 'session'], write_scopes=['session'], archive_scopes=['session']))),
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
