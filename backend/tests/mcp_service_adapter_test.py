# -*- coding: utf-8 -*-
"""MCPService 通过 execution adapter 的委派测试。"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))


class _BaseModel:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)

    def model_dump(self, exclude_none: bool = False):
        data = dict(self.__dict__)
        if exclude_none:
            data = {key: value for key, value in data.items() if value is not None}
        return data


def _field(default=None, **kwargs):
    if default is ...:
        return None
    return default


sys.modules.setdefault('pydantic', types.SimpleNamespace(BaseModel=_BaseModel, Field=_field))

from services.mcp_service import MCPService, MCPServiceError


class _FakeStore:
    def __init__(self):
        self.updated = None
        self.removed = None

    def get_server(self, server_name: str):
        if server_name == 'missing':
            return None
        return {'name': server_name, 'transport': 'stdio', 'command': 'demo', 'enabled': True, 'auto_connect': True}

    def update_server(self, server_name: str, payload):
        self.updated = (server_name, payload)

    def remove_server(self, server_name: str):
        self.removed = server_name

    def add_server(self, config):
        self.added = config

    def list_servers(self):
        return []


class _FakeManager:
    pass


class _FakeAdapter:
    def __init__(self):
        self.calls = []

    def connect_server(self, server_name: str, *, manager, request_id=None):
        self.calls.append(('connect', server_name, manager, request_id))
        return {'success': True, 'status': {'server_name': server_name, 'status': 'connected', 'tool_count': 1, 'error_message': ''}}

    def disconnect_server(self, server_name: str, *, manager, request_id=None):
        self.calls.append(('disconnect', server_name, manager, request_id))
        return {'status': {'server_name': server_name, 'status': 'disconnected'}}

    def refresh_server(self, server_name: str, *, manager, request_id=None):
        self.calls.append(('refresh', server_name, manager, request_id))
        return {'server_name': server_name, 'status': 'connected', 'tool_count': 1, 'error_message': ''}

    def test_server(self, server_name: str, *, manager, request_id=None):
        self.calls.append(('test', server_name, manager, request_id))
        return {'success': True, 'message': 'ok', 'tool_count': 1}

    def call_tool(self, server_name: str, tool_name: str, arguments: dict, *, manager, session_id=None, run_id=None, request_id=None):
        self.calls.append(('call_tool', server_name, tool_name, arguments, manager, session_id, run_id, request_id))
        return {'success': True, 'results': arguments}


class MCPServiceAdapterTest(unittest.TestCase):
    def test_connect_server_uses_execution_adapter(self) -> None:
        adapter = _FakeAdapter()
        manager = _FakeManager()
        service = MCPService(store=_FakeStore(), manager=manager, execution_adapter=adapter)

        result = service.connect_server('demo', request_id='req-connect')

        self.assertEqual(result['status'], 'connected')
        self.assertEqual(adapter.calls[0][0], 'connect')
        self.assertEqual(adapter.calls[0][-1], 'req-connect')

    def test_call_tool_passes_session_id(self) -> None:
        adapter = _FakeAdapter()
        manager = _FakeManager()
        service = MCPService(store=_FakeStore(), manager=manager, execution_adapter=adapter)

        result = service.call_tool('demo', 'search', {'q': 1}, session_id='session-9', run_id='run-9', request_id='req-9')

        self.assertTrue(result['success'])
        self.assertEqual(adapter.calls[0][5], 'session-9')
        self.assertEqual(adapter.calls[0][6], 'run-9')
        self.assertEqual(adapter.calls[0][7], 'req-9')

    def test_update_missing_server_raises(self) -> None:
        service = MCPService(store=_FakeStore(), manager=_FakeManager(), execution_adapter=_FakeAdapter())

        with self.assertRaises(MCPServiceError):
            service.update_server('missing', {'timeout': 30})


if __name__ == '__main__':
    unittest.main()
