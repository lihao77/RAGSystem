# -*- coding: utf-8 -*-
"""观测字段路由与 SSE 契约测试。"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from flask import Flask
except ImportError:  # pragma: no cover - 测试环境缺依赖时跳过
    Flask = None

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from agents.events.bus import Event, EventType
from execution.observability import attach_execution_metadata

if Flask is not None:
    from routes.agent_api.stream_helpers import format_event_to_sse
    from routes.mcp import mcp_bp
    from routes.nodes import nodes_bp
else:  # pragma: no cover - 测试环境缺依赖时跳过
    format_event_to_sse = None
    mcp_bp = None
    nodes_bp = None


class _FakeMCPService:
    def __init__(self):
        self.calls = []

    def connect_server(self, server_name: str, *, request_id=None):
        self.calls.append((server_name, request_id))
        return {'server_name': server_name, 'status': 'connected', 'tool_count': 0, 'error_message': ''}


class _FakeNodeExecutionAdapter:
    calls = []

    def execute(self, payload, *, node_service, session_id=None, run_id=None, request_id=None):
        self.__class__.calls.append({
            'payload': payload,
            'node_service': node_service,
            'session_id': session_id,
            'run_id': run_id,
            'request_id': request_id,
        })
        return {'ok': True, 'node_type': payload.get('node_type')}


class RouteObservabilityContractTest(unittest.TestCase):
    @unittest.skipIf(Flask is None, 'flask 未安装')
    def test_mcp_route_passes_request_id_to_service(self) -> None:
        app = Flask(__name__)
        app.register_blueprint(mcp_bp, url_prefix='/api/mcp')
        service = _FakeMCPService()

        with patch('routes.mcp.get_mcp_service', return_value=service):
            with app.test_client() as client:
                response = client.post('/api/mcp/servers/demo/connect', headers={'X-Request-ID': 'req-mcp-1'})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(service.calls, [('demo', 'req-mcp-1')])

    @unittest.skipIf(Flask is None, 'flask 未安装')
    def test_nodes_route_passes_request_id_run_id_and_session_id(self) -> None:
        app = Flask(__name__)
        app.register_blueprint(nodes_bp)
        payload = {'node_type': 'demo', 'session_id': 'session-node', 'run_id': 'run-node'}
        _FakeNodeExecutionAdapter.calls = []

        with patch('routes.nodes.NodeExecutionAdapter', return_value=_FakeNodeExecutionAdapter()):
            with patch('routes.nodes.get_node_service', return_value='node-service'):
                with app.test_client() as client:
                    response = client.post('/api/nodes/execute', json=payload, headers={'X-Request-ID': 'req-node-1'})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(_FakeNodeExecutionAdapter.calls), 1)
        call = _FakeNodeExecutionAdapter.calls[0]
        self.assertEqual(call['session_id'], 'session-node')
        self.assertEqual(call['run_id'], 'run-node')
        self.assertEqual(call['request_id'], 'req-node-1')

    @unittest.skipIf(Flask is None, 'flask 未安装')
    def test_format_event_to_sse_flattens_execution_fields(self) -> None:
        event = Event(
            type=EventType.RUN_END,
            data=attach_execution_metadata(
                {'content': 'done'},
                task_id='task-1',
                session_id='session-1',
                run_id='run-1',
                execution_kind='agent_stream',
                request_id='req-1',
            ),
            session_id='session-1',
            agent_name='master_agent_v2',
        )

        payload = json.loads(format_event_to_sse(event).removeprefix('data: ').strip())

        self.assertEqual(payload['task_id'], 'task-1')
        self.assertEqual(payload['session_id'], 'session-1')
        self.assertEqual(payload['run_id'], 'run-1')
        self.assertEqual(payload['execution_kind'], 'agent_stream')
        self.assertEqual(payload['request_id'], 'req-1')
        self.assertEqual(payload['data']['_execution']['task_id'], 'task-1')


if __name__ == '__main__':
    unittest.main()
