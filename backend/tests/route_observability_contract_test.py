# -*- coding: utf-8 -*-
"""观测字段路由与 SSE 契约测试。"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
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
    try:
        import routes.agent_api.stream_control  # noqa: F401
        import routes.agent_api.stream_run  # noqa: F401
        from routes.agent_api.shared import agent_bp
        from routes.agent_api.stream_helpers import format_event_to_sse
        from routes.mcp import mcp_bp
        from routes.nodes import nodes_bp
        _ROUTE_IMPORTS_READY = True
    except Exception:  # pragma: no cover - 测试环境缺依赖时跳过
        agent_bp = None
        format_event_to_sse = None
        mcp_bp = None
        nodes_bp = None
        _ROUTE_IMPORTS_READY = False
else:  # pragma: no cover - 测试环境缺依赖时跳过
    agent_bp = None
    format_event_to_sse = None
    mcp_bp = None
    nodes_bp = None
    _ROUTE_IMPORTS_READY = False


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


class _FakeEventBus:
    def __init__(self, history=None):
        self._history = history or []

    def get_event_history(self, session_id=None, limit=1000):
        return list(self._history)


class _FakeSSEAdapter:
    def __init__(self, *args, **kwargs):
        self._items = kwargs.pop('items', [])

    def start(self):
        return None

    def stop(self):
        return None

    def stream_sync(self):
        for item in self._items:
            yield item


class _FakeExecutionService:
    def cleanup_finished(self):
        return None


class RouteObservabilityContractTest(unittest.TestCase):
    @unittest.skipIf(Flask is None or not _ROUTE_IMPORTS_READY, 'flask 或 agent routes 未就绪')
    def test_mcp_route_passes_request_id_to_service(self) -> None:
        app = Flask(__name__)
        app.register_blueprint(mcp_bp, url_prefix='/api/mcp')
        service = _FakeMCPService()

        with patch('routes.mcp.get_mcp_service', return_value=service):
            with app.test_client() as client:
                response = client.post('/api/mcp/servers/demo/connect', headers={'X-Request-ID': 'req-mcp-1'})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(service.calls, [('demo', 'req-mcp-1')])

    @unittest.skipIf(Flask is None or not _ROUTE_IMPORTS_READY, 'flask 或 agent routes 未就绪')
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

    @unittest.skipIf(Flask is None or not _ROUTE_IMPORTS_READY, 'flask 或 agent routes 未就绪')
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

    @unittest.skipIf(Flask is None or not _ROUTE_IMPORTS_READY, 'flask 或 agent routes 未就绪')
    def test_agent_stream_done_event_contains_observability_fields(self) -> None:
        app = Flask(__name__)
        app.register_blueprint(agent_bp, url_prefix='/api/agent')
        started = SimpleNamespace(
            started=True,
            session_id='session-stream',
            run_id='run-stream',
            task_id='task-stream',
            request_id='req-stream',
            sse_adapter=_FakeSSEAdapter(items=['data: {"type": "chunk", "content": "hi"}\n\n']),
        )

        with patch('routes.agent_api.stream_run.AgentExecutionAdapter') as adapter_cls:
            adapter_cls.return_value.start_stream_execution.return_value = started
            with patch('routes.agent_api.stream_run._get_conversation_store', return_value=object()):
                with patch('routes.agent_api.stream_run._get_orchestrator', return_value=object()):
                    with patch('services.execution_service.get_execution_service', return_value=_FakeExecutionService()):
                        with app.test_client() as client:
                            response = client.post(
                                '/api/agent/stream',
                                json={'task': 'hello', 'session_id': 'session-stream'},
                                headers={'X-Request-ID': 'req-stream'},
                            )

        self.assertEqual(response.status_code, 200)
        body = response.get_data(as_text=True)
        done_payload = json.loads(body.strip().split('data: ')[-1])
        self.assertEqual(done_payload['type'], 'done')
        self.assertEqual(done_payload['task_id'], 'task-stream')
        self.assertEqual(done_payload['session_id'], 'session-stream')
        self.assertEqual(done_payload['run_id'], 'run-stream')
        self.assertEqual(done_payload['execution_kind'], 'agent_stream')
        self.assertEqual(done_payload['request_id'], 'req-stream')

    @unittest.skipIf(Flask is None or not _ROUTE_IMPORTS_READY, 'flask 或 agent routes 未就绪')
    def test_agent_reconnect_events_contain_observability_fields(self) -> None:
        app = Flask(__name__)
        app.register_blueprint(agent_bp, url_prefix='/api/agent')
        event = Event(
            type=EventType.RUN_END,
            data=attach_execution_metadata(
                {'content': 'done'},
                task_id='task-reconnect',
                session_id='session-reconnect',
                run_id='run-reconnect',
                execution_kind='agent_stream',
                request_id='req-reconnect',
            ),
            session_id='session-reconnect',
            agent_name='master_agent_v2',
        )
        status = {
            'task_id': 'task-reconnect',
            'session_id': 'session-reconnect',
            'run_id': 'run-reconnect',
            'execution_kind': 'agent_stream',
            'request_id': 'req-reconnect',
            'status': 'running',
            'started_at': 0,
        }

        with patch('routes.agent_api.stream_control.get_execution_service', return_value=SimpleNamespace(get_status_by_session=lambda session_id: status)):
            with patch('routes.agent_api.stream_control.get_session_event_bus', return_value=_FakeEventBus(history=[event])):
                with patch('routes.agent_api.stream_control.SSEAdapter', return_value=_FakeSSEAdapter(items=[])):
                    with app.test_client() as client:
                        response = client.post(
                            '/api/agent/stream/reconnect',
                            json={'session_id': 'session-reconnect'},
                            headers={'X-Request-ID': 'req-reconnect'},
                        )

        self.assertEqual(response.status_code, 200)
        data_lines = [line.removeprefix('data: ') for line in response.get_data(as_text=True).splitlines() if line.startswith('data: ')]
        reconnect_start = json.loads(data_lines[0])
        replay_event = json.loads(data_lines[1])
        done_payload = json.loads(data_lines[-1])
        self.assertEqual(reconnect_start['task_id'], 'task-reconnect')
        self.assertEqual(reconnect_start['run_id'], 'run-reconnect')
        self.assertEqual(reconnect_start['request_id'], 'req-reconnect')
        self.assertEqual(replay_event['task_id'], 'task-reconnect')
        self.assertEqual(replay_event['execution_kind'], 'agent_stream')
        self.assertEqual(done_payload['task_id'], 'task-reconnect')
        self.assertEqual(done_payload['request_id'], 'req-reconnect')


if __name__ == '__main__':
    unittest.main()
