# -*- coding: utf-8 -*-
import importlib.util
from pathlib import Path

import pytest

pytest.importorskip('fastapi')
pytest.importorskip('fastapi.testclient')


def _load_daemon_router():
    module_path = Path(__file__).resolve().parents[3] / 'api' / 'v1' / 'daemon.py'
    spec = importlib.util.spec_from_file_location('isolated_daemon_api', module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module.router


class _FakeAdapter:
    def parse_webhook(self, payload):
        return []


class _FakeDaemonService:
    def __init__(self):
        self.running = True
        self.saved_config = None
        self.calls = []
        self._adapters = {}

    async def stop(self):
        self.calls.append('stop')
        self.running = False

    def save_config(self, new_config):
        self.calls.append('save')
        self.saved_config = new_config

    async def start(self):
        self.calls.append('start')
        self.running = True

    @property
    def config(self):
        from daemon.models import DaemonSystemConfig
        return DaemonSystemConfig()


class _FakeContainer:
    def __init__(self, daemon_service):
        self._daemon_service = daemon_service

    def get_daemon_service(self):
        return self._daemon_service


def test_update_config_restarts_running_daemon():
    fastapi = pytest.importorskip('fastapi')
    testclient_mod = pytest.importorskip('fastapi.testclient')
    FastAPI = fastapi.FastAPI
    TestClient = testclient_mod.TestClient

    daemon_router = _load_daemon_router()

    daemon_service = _FakeDaemonService()

    app = FastAPI()
    app.include_router(daemon_router, prefix='/api/daemon')
    app.state.runtime_container = _FakeContainer(daemon_service)

    client = TestClient(app)
    payload = {
        'enabled': True,
        'default_session_ttl': 86400,
        'agents': [
            {
                'team_name': 'default',
                'entry_agent': None,
                'enabled': True,
                'heartbeat_interval': 30,
                'platforms': {},
                'cron_tasks': [],
            }
        ],
    }

    response = client.put('/api/daemon/config', json=payload)

    assert response.status_code == 200
    assert daemon_service.calls == ['stop', 'save', 'start']
    assert daemon_service.saved_config.enabled is True


def test_feishu_webhook_challenge_returns_raw_challenge():
    fastapi = pytest.importorskip('fastapi')
    testclient_mod = pytest.importorskip('fastapi.testclient')
    FastAPI = fastapi.FastAPI
    TestClient = testclient_mod.TestClient

    daemon_router = _load_daemon_router()

    daemon_service = _FakeDaemonService()

    app = FastAPI()
    app.include_router(daemon_router, prefix='/api/daemon')
    app.state.runtime_container = _FakeContainer(daemon_service)

    client = TestClient(app)
    response = client.post('/api/daemon/webhook/feishu', json={'challenge': 'abc123'})

    assert response.status_code == 200
    assert response.json() == {'challenge': 'abc123'}


def test_feishu_long_connection_event_maps_to_incoming_message():
    from daemon.gateway.feishu import FeishuAdapter
    from daemon.models import PlatformConnection, PlatformType

    adapter = FeishuAdapter(
        PlatformConnection(
            enabled=True,
            app_id='cli_xxx',
            app_secret='secret',
            token='verify_token',
            extra={'receive_mode': 'long_connection'},
        )
    )

    class SenderId:
        user_id = 'ou_user_1'
        open_id = 'ou_open_1'
        union_id = 'union_1'

    class Sender:
        sender_id = SenderId()

    class Message:
        chat_id = 'oc_chat_123'
        message_id = 'om_456'
        message_type = 'text'
        content = '{"text":"你好"}'
        create_time = 1712920000123

    class Event:
        sender = Sender()
        message = Message()

    class Data:
        event = Event()

    incoming = adapter._build_incoming_message_from_long_connection_event(Data())

    assert incoming is not None
    assert incoming.platform == PlatformType.FEISHU
    assert incoming.chat_id == 'oc_chat_123'
    assert incoming.user_id == 'ou_user_1'
    assert incoming.message_id == 'om_456'
    assert incoming.content == '你好'
    assert isinstance(incoming.timestamp, float)


def test_feishu_receive_mode_defaults_to_webhook():
    from daemon.gateway.feishu import FeishuAdapter
    from daemon.models import PlatformConnection

    adapter = FeishuAdapter(PlatformConnection(enabled=True))
    assert adapter._receive_mode() == 'webhook'
    assert adapter._use_long_connection() is False

    adapter = FeishuAdapter(
        PlatformConnection(enabled=True, extra={'receive_mode': 'long_connection'})
    )
    assert adapter._receive_mode() == 'long_connection'
    assert adapter._use_long_connection() is True
