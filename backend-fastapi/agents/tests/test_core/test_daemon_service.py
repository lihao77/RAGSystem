# -*- coding: utf-8 -*-
import asyncio
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from daemon.models import CronTask, DaemonSystemConfig, PlatformConnection, PlatformType
from daemon.service import DaemonService


class _FakeConversationStore:
    def __init__(self):
        self.created = []

    def create_session(self, session_id, metadata):
        self.created.append({'session_id': session_id, 'metadata': metadata})


class _FakeExecService:
    def __init__(self, content='cron done'):
        self.content = content
        self.calls = []
        self.routed_calls = []

    def invoke_agent(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            response=SimpleNamespace(success=True, content=self.content)
        )

    def invoke_routed_agent(self, **kwargs):
        self.routed_calls.append(kwargs)
        return SimpleNamespace(
            response=SimpleNamespace(success=True, content=self.content)
        )


class _FakeRuntimeService:
    def __init__(self, store, exec_service):
        self._store = store
        self._exec_service = exec_service

    def get_conversation_store(self):
        return self._store

    def get_agent_execution_service(self):
        return self._exec_service


class _FakeContainer:
    def __init__(self, runtime_service):
        self._runtime_service = runtime_service

    def get_agent_api_runtime_service(self):
        return self._runtime_service


@pytest.fixture()
def daemon_service(monkeypatch):
    service = DaemonService()
    temp_dir = tempfile.TemporaryDirectory()
    config_path = Path(temp_dir.name) / 'daemon.yaml'
    monkeypatch.setattr(service, '_resolve_config_path', lambda: config_path)
    service._config = DaemonSystemConfig(
        enabled=True,
        agents=[
            {
                'team_name': 'default',
                'enabled': True,
                'platforms': {},
                'cron_tasks': [],
                'heartbeat_interval': 30,
            }
        ],
        default_session_ttl=86400,
    )
    try:
        yield service
    finally:
        temp_dir.cleanup()


def test_get_or_create_session_creates_session_with_team_metadata(daemon_service, monkeypatch):
    store = _FakeConversationStore()
    runtime_service = _FakeRuntimeService(store, _FakeExecService())
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    session_id = daemon_service._get_or_create_session('chat_1', 'default', 'agent_x')

    assert session_id.startswith('daemon_')
    assert store.created == [
        {
            'session_id': session_id,
            'metadata': {
                'source': 'daemon',
                'chat_id': 'chat_1',
                'team': 'default',
                'entry_agent': 'agent_x',
            },
        }
    ]


def test_session_id_is_deterministic_across_restarts(daemon_service, monkeypatch):
    """同一 chat_id + team_name 产生相同 session_id，模拟重启后复用。"""
    store = _FakeConversationStore()
    runtime_service = _FakeRuntimeService(store, _FakeExecService())
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    # 首次调用
    sid_1 = daemon_service._get_or_create_session('chat_1', 'default')

    # 模拟重启：清空内存缓存
    daemon_service._daemon_sessions.clear()
    daemon_service._session_timestamps.clear()

    # 重启后再次调用，应得到相同 session_id
    sid_2 = daemon_service._get_or_create_session('chat_1', 'default')

    assert sid_1 == sid_2
    # create_session 被调用了两次（幂等），session_id 相同
    assert store.created[0]['session_id'] == store.created[1]['session_id']


def test_different_chats_get_different_session_ids(daemon_service, monkeypatch):
    store = _FakeConversationStore()
    runtime_service = _FakeRuntimeService(store, _FakeExecService())
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    sid_a = daemon_service._get_or_create_session('chat_a', 'default')
    sid_b = daemon_service._get_or_create_session('chat_b', 'default')

    assert sid_a != sid_b


def test_execute_cron_task_updates_last_run_and_last_result(daemon_service, monkeypatch):
    store = _FakeConversationStore()
    exec_service = _FakeExecService('daily report')
    runtime_service = _FakeRuntimeService(store, exec_service)
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    task = CronTask(
        task_id='cron_1',
        name='daily',
        cron='0 9 * * *',
        task='send report',
        team_name='default',
    )

    result = asyncio.run(daemon_service.execute_cron_task(task))

    assert result == 'daily report'
    assert task.last_run is not None
    assert task.last_result == 'daily report'
    assert exec_service.calls == []
    assert exec_service.routed_calls[0]['source'] == 'daemon.cron'


def test_execute_cron_task_uses_routed_agent_when_entry_agent_missing(daemon_service, monkeypatch):
    store = _FakeConversationStore()
    exec_service = _FakeExecService('daily report')
    runtime_service = _FakeRuntimeService(store, exec_service)
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    task = CronTask(
        task_id='cron_2',
        name='daily',
        cron='0 9 * * *',
        task='send report',
        team_name='default',
        entry_agent=None,
    )

    result = asyncio.run(daemon_service.execute_cron_task(task))

    assert result == 'daily report'
    assert exec_service.calls == []
    assert exec_service.routed_calls[0]['source'] == 'daemon.cron'


def test_cron_task_crud_persists_to_daemon_yaml(daemon_service):
    task = CronTask(
        task_id='cron_1',
        name='daily',
        cron='0 9 * * *',
        task='send report',
        team_name='default',
    )

    asyncio.run(daemon_service.add_cron_task(task))
    saved_after_add = daemon_service.load_config()
    assert [t.task_id for t in saved_after_add.agents[0].cron_tasks] == ['cron_1']

    updated = asyncio.run(daemon_service.update_cron_task('cron_1', {'cron': '5 9 * * *', 'enabled': False}))
    assert updated is not None
    saved_after_update = daemon_service.load_config()
    assert saved_after_update.agents[0].cron_tasks[0].cron == '5 9 * * *'
    assert saved_after_update.agents[0].cron_tasks[0].enabled is False

    deleted = asyncio.run(daemon_service.delete_cron_task('cron_1'))
    assert deleted is True
    saved_after_delete = daemon_service.load_config()
    assert saved_after_delete.agents[0].cron_tasks == []


def test_save_config_serializes_platform_keys_as_plain_yaml(daemon_service):
    daemon_service._config = DaemonSystemConfig(
        enabled=True,
        agents=[
            {
                'team_name': 'default',
                'enabled': True,
                'platforms': {
                    PlatformType.FEISHU: PlatformConnection(enabled=True, app_id='cli_xxx')
                },
                'cron_tasks': [],
                'heartbeat_interval': 30,
            }
        ],
        default_session_ttl=86400,
    )

    daemon_service.save_config(daemon_service.config)
    raw = daemon_service._resolve_config_path().read_text(encoding='utf-8')

    assert '!!python/object/apply' not in raw
    assert 'feishu:' in raw


def test_daemon_config_rejects_duplicate_enabled_platforms():
    with pytest.raises(ValueError, match='平台 feishu 只能被一个已启用 team 占用'):
        DaemonSystemConfig(
            enabled=True,
            agents=[
                {
                    'team_name': 'team_a',
                    'enabled': True,
                    'platforms': {
                        PlatformType.FEISHU: PlatformConnection(enabled=True)
                    },
                    'cron_tasks': [],
                    'heartbeat_interval': 30,
                },
                {
                    'team_name': 'team_b',
                    'enabled': True,
                    'platforms': {
                        PlatformType.FEISHU: PlatformConnection(enabled=True)
                    },
                    'cron_tasks': [],
                    'heartbeat_interval': 30,
                },
            ],
        )
