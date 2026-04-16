# -*- coding: utf-8 -*-
import asyncio
import json
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agents.events.bus import EventType
from daemon.models import CronTask, DaemonSystemConfig, PlatformConnection, PlatformType
from daemon.service import DaemonService


class _FakeConversationStore:
    def __init__(self):
        self.created = []

    def create_session(self, session_id, metadata):
        self.created.append({'session_id': session_id, 'metadata': metadata})

    def get_session(self, session_id):
        return {'session_id': session_id}


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

    def create_execution_orchestrator(self, *, session_id=None):
        return MagicMock()


class _FakeEventBus:
    def __init__(self):
        self.subscriptions = []

    def subscribe(self, *, event_types=None, handler=None, **kwargs):
        self.subscriptions.append({'event_types': event_types, 'handler': handler})
        return f'sub_{len(self.subscriptions)}'


class _FakeSessionManager:
    def __init__(self):
        self._buses = {}

    def get_or_create(self, run_id, *, session_id=None):
        bus = self._buses.get(run_id)
        if bus is None:
            bus = _FakeEventBus()
            self._buses[run_id] = bus
        return bus

    def remove(self, run_id):
        self._buses.pop(run_id, None)


class _FakeTaskRegistry:
    def __init__(self):
        self._task_counter = 0

    def register_task(self, **kwargs):
        self._task_counter += 1
        return f'task_{self._task_counter}'

    def finish_task(self, task_id, **kwargs):
        pass


class _FakeExecutionService:
    def __init__(self):
        self._task_registry = _FakeTaskRegistry()
        self._session_manager = _FakeSessionManager()

    def get_task_registry(self):
        return self._task_registry

    def get_session_manager(self):
        return self._session_manager

    def submit(self, *args, **kwargs):
        return MagicMock(thread=None)

    def cleanup_finished(self):
        pass


class _FakeSSEAdapter:
    """Fake SSEAdapter that yields a FINAL_ANSWER event then terminates."""

    def __init__(self, content='cron done', error=None):
        self.content = content
        self.error = error
        self.completed_normally = True
        self.terminal_event_type = 'run.end'

    def stream_sync(self):
        if self.error:
            err = {'type': 'system.error', 'data': {'message': self.error}}
            yield f'data: {json.dumps(err)}\n\n'
            return
        event = {
            'type': 'output.final_answer',
            'data': {'content': self.content},
            'session_id': 'test',
        }
        yield f'data: {json.dumps(event)}\n\n'
        done = {'type': 'run.end', 'data': {}}
        yield f'data: {json.dumps(done)}\n\n'

    def start(self):
        pass

    def stop(self):
        pass


class _FakeContainer:
    def __init__(self, runtime_service, execution_service=None):
        self._runtime_service = runtime_service
        self._session_manager = _FakeSessionManager()
        self._execution_service = execution_service or _FakeExecutionService()

    def get_agent_api_runtime_service(self):
        return self._runtime_service

    def get_session_manager(self):
        return self._session_manager

    def get_execution_service(self):
        return self._execution_service


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


# ──────────────────────────────────────────────
# Session 管理测试
# ──────────────────────────────────────────────

def test_get_or_create_session_creates_session_with_team_metadata(daemon_service, monkeypatch):
    store = _FakeConversationStore()
    runtime_service = _FakeRuntimeService(store, _FakeExecService())
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    session_id = asyncio.run(daemon_service._get_or_create_session('chat_1', 'default', 'agent_x'))

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

    sid_1 = asyncio.run(daemon_service._get_or_create_session('chat_1', 'default'))

    daemon_service._daemon_sessions.clear()
    daemon_service._session_timestamps.clear()

    sid_2 = asyncio.run(daemon_service._get_or_create_session('chat_1', 'default'))

    assert sid_1 == sid_2
    assert store.created[0]['session_id'] == store.created[1]['session_id']


def test_different_chats_get_different_session_ids(daemon_service, monkeypatch):
    store = _FakeConversationStore()
    runtime_service = _FakeRuntimeService(store, _FakeExecService())
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    sid_a = asyncio.run(daemon_service._get_or_create_session('chat_a', 'default'))
    sid_b = asyncio.run(daemon_service._get_or_create_session('chat_b', 'default'))

    assert sid_a != sid_b


def _make_fake_adapter_start_result(content='daily report', error=None):
    """Create a fake AgentStreamStartResult."""
    from execution.adapters.agent_execution import AgentStreamStartResult
    return AgentStreamStartResult(
        started=True,
        session_id='test_session',
        run_id='test_run',
        task_id='test_task',
        request_id='test_req',
    )


# ──────────────────────────────────────────────
# Cron 任务执行测试
# ──────────────────────────────────────────────

def test_execute_cron_task_uses_adapter_and_returns_content(daemon_service, monkeypatch):
    """Cron 任务通过 AgentExecutionAdapter 执行，返回 final_answer。"""
    store = _FakeConversationStore()
    exec_service = _FakeExecService('daily report')
    runtime_service = _FakeRuntimeService(store, exec_service)
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    fake_result = _make_fake_adapter_start_result('daily report')
    with patch('execution.adapters.agent_execution.AgentExecutionAdapter') as MockAdapter:
        MockAdapter.return_value.start_stream_execution.return_value = fake_result
        monkeypatch.setattr('agents.context.session_cache.flush_session', lambda sid: None, raising=False)
        monkeypatch.setattr('agents.events.session_manager.cleanup_run', lambda rid: None, raising=False)
        monkeypatch.setattr('daemon.utils.wait_for_run_end', lambda *args, **kwargs: 'daily report')

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
    call_kwargs = MockAdapter.return_value.start_stream_execution.call_args
    assert call_kwargs.kwargs['source'] == 'daemon.cron'


def test_execute_cron_task_handles_adapter_failure(daemon_service, monkeypatch):
    """Adapter 启动失败时返回 None 并记录错误。"""
    store = _FakeConversationStore()
    runtime_service = _FakeRuntimeService(store, _FakeExecService())
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    from execution.adapters.agent_execution import AgentStreamStartResult
    failed_result = AgentStreamStartResult(
        started=False,
        session_id='test',
        error_message='并发冲突',
    )
    with patch('execution.adapters.agent_execution.AgentExecutionAdapter') as MockAdapter:
        MockAdapter.return_value.start_stream_execution.return_value = failed_result

        task = CronTask(
            task_id='cron_fail',
            name='daily',
            cron='0 9 * * *',
            task='send report',
            team_name='default',
        )

        result = asyncio.run(daemon_service.execute_cron_task(task))

    assert result is None
    assert '并发冲突' in task.last_result


def test_execute_cron_task_uses_session_permission_override(daemon_service, monkeypatch):
    """Cron 任务使用 session 级权限覆盖，不污染全局策略。"""
    from tools.permission_manager import get_permission_policy, get_effective_permission_policy
    from tools.contracts.permission_modes import PermissionMode, PermissionPolicy

    daemon_service._config.agents[0].permissions = PermissionPolicy(mode=PermissionMode.RELAXED)

    store = _FakeConversationStore()
    runtime_service = _FakeRuntimeService(store, _FakeExecService())
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    global_before = get_permission_policy().mode
    observed = {}

    fake_result = _make_fake_adapter_start_result('done')
    with patch('execution.adapters.agent_execution.AgentExecutionAdapter') as MockAdapter:
        def _start_stream_execution(**kwargs):
            observed['effective_mode_during_start'] = get_effective_permission_policy(kwargs['session_id']).mode
            return fake_result

        MockAdapter.return_value.start_stream_execution.side_effect = _start_stream_execution
        monkeypatch.setattr('agents.context.session_cache.flush_session', lambda sid: None, raising=False)
        monkeypatch.setattr('agents.events.session_manager.cleanup_run', lambda rid: None, raising=False)
        monkeypatch.setattr('daemon.utils.wait_for_run_end', lambda *args, **kwargs: 'done')

        task = CronTask(
            task_id='cron_perm',
            name='test',
            cron='0 9 * * *',
            task='test',
            team_name='default',
        )

        asyncio.run(daemon_service.execute_cron_task(task))

    assert observed['effective_mode_during_start'] == PermissionMode.RELAXED
    assert get_permission_policy().mode == global_before


def test_daemon_event_bridge_uses_single_subscription(monkeypatch):
    from daemon.gateway.router import MessageRouter
    from daemon.models import IncomingMessage

    router = MessageRouter(daemon_service=MagicMock())
    message = IncomingMessage(
        message_id='m1',
        platform=PlatformType.FEISHU,
        chat_id='chat_1',
        user_id='u1',
        content='hello',
        timestamp=0,
    )

    event_bus = _FakeEventBus()
    approval_handler = MagicMock()
    approval_handler.cleanup.return_value = None
    started = _make_fake_adapter_start_result('done')
    runtime_service = _FakeRuntimeService(_FakeConversationStore(), _FakeExecService())
    container = _FakeContainer(runtime_service)
    container._session_manager._buses[started.run_id] = event_bus

    fake_agent_cfg = SimpleNamespace(permissions=None)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)
    monkeypatch.setattr(router._daemon_service, 'resolve_session_id_for_message', AsyncMock(return_value=('daemon_session', fake_agent_cfg)))
    monkeypatch.setattr(router._daemon_service, '_build_default_daemon_permission_policy', lambda: SimpleNamespace(approval_timeout=300))
    monkeypatch.setattr('daemon.utils.wait_for_run_end', lambda *args, **kwargs: 'done')
    router._daemon_service.send_message = AsyncMock()
    with patch('execution.adapters.agent_execution.AgentExecutionAdapter', return_value=MagicMock(start_stream_execution=MagicMock(return_value=started))):
        with patch('daemon.approval_handler.DaemonApprovalHandler', return_value=approval_handler):
            run_ctx = asyncio.run(router._start_agent_run(message))

    assert run_ctx is not None
    assert len(event_bus.subscriptions) == 1
    assert event_bus.subscriptions[0]['event_types'] == [
        EventType.USER_APPROVAL_REQUIRED,
        EventType.USER_INPUT_REQUIRED,
        EventType.AGENT_ERROR,
        EventType.CALL_TOOL_START,
        EventType.CALL_TOOL_END,
        EventType.AGENT_RETRY_SCHEDULED,
        EventType.INTENT_COMPLETE,
    ]


# ──────────────────────────────────────────────
# Cron CRUD + 配置测试
# ──────────────────────────────────────────────

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


# ──────────────────────────────────────────────
# Session 解析优先级测试
# ──────────────────────────────────────────────

def test_configured_session_id_takes_priority(daemon_service, monkeypatch):
    """显式 configured_session_id 优先于 auto-derive。"""
    store = _FakeConversationStore()
    runtime_service = _FakeRuntimeService(store, _FakeExecService())
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    sid = asyncio.run(daemon_service._get_or_create_session(
        'chat_1', 'default', configured_session_id='my_custom_session'
    ))
    assert sid == 'my_custom_session'
    assert store.created[0]['session_id'] == 'my_custom_session'


def test_configured_session_id_none_falls_back_to_derive(daemon_service, monkeypatch):
    """configured_session_id=None 时回退到 auto-derive。"""
    store = _FakeConversationStore()
    runtime_service = _FakeRuntimeService(store, _FakeExecService())
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    sid = asyncio.run(daemon_service._get_or_create_session(
        'chat_1', 'default', configured_session_id=None
    ))
    assert sid.startswith('daemon_')


def test_resolve_session_id_platform_overrides_agent(daemon_service, monkeypatch):
    """platform.session_id 优先于 agent.session_id。"""
    from daemon.models import DaemonAgentConfig, IncomingMessage

    daemon_service._config.agents = [
        DaemonAgentConfig(
            team_name='default',
            enabled=True,
            session_id='agent_level_session',
            platforms={
                PlatformType.FEISHU: PlatformConnection(
                    enabled=True,
                    session_id='platform_level_session',
                ),
            },
        ),
    ]

    store = _FakeConversationStore()
    runtime_service = _FakeRuntimeService(store, _FakeExecService())
    container = _FakeContainer(runtime_service)
    monkeypatch.setattr('runtime.container.get_current_runtime_container', lambda: container)

    msg = IncomingMessage(
        message_id='m1', platform=PlatformType.FEISHU,
        chat_id='chat_1', user_id='u1', content='hello', timestamp=0,
    )
    sid, cfg = asyncio.run(daemon_service.resolve_session_id_for_message(msg))
    assert sid == 'platform_level_session'
    assert cfg.team_name == 'default'


def test_periodic_session_eviction_removes_expired_sessions(daemon_service):
    daemon_service._daemon_sessions = {
        'expired_chat': 'session_old',
        'fresh_chat': 'session_new',
    }
    now = 10_000.0
    daemon_service._session_timestamps = {
        'expired_chat': now - daemon_service.config.default_session_ttl - 1,
        'fresh_chat': now,
    }

    with patch('daemon.service.time.time', return_value=now):
        asyncio.run(daemon_service._periodic_session_eviction())

    assert daemon_service._daemon_sessions == {'fresh_chat': 'session_new'}
    assert daemon_service._session_timestamps == {'fresh_chat': now}


# ──────────────────────────────────────────────
# consume_stream 测试
# ──────────────────────────────────────────────

def test_consume_stream_extracts_final_answer():
    from daemon.utils import consume_stream
    adapter = _FakeSSEAdapter('hello world')
    result = consume_stream(adapter)
    assert result == 'hello world'


def test_consume_stream_returns_error_on_system_error():
    from daemon.utils import consume_stream
    adapter = _FakeSSEAdapter(error='something went wrong')
    result = consume_stream(adapter)
    assert result == 'ERROR: something went wrong'
