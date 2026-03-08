# -*- coding: utf-8 -*-
"""MCPExecutionAdapter 测试。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from agents.task_registry import TaskRegistry
from execution import ExecutionRequest, InProcessExecutionRunner
from execution.adapters.mcp_execution import MCPExecutionAdapter
from execution.observability import get_current_execution_observability_fields
from services.execution_service import ExecutionService


class _FakeSessionManager:
    def get(self, session_id: str):
        return None

    def get_or_create(self, session_id: str):
        return None


class _FakeManager:
    def __init__(self):
        self.calls = []
        self.observability = []

    def connect_server(self, server_name: str):
        self.calls.append(('connect', server_name))
        return True

    def disconnect_server(self, server_name: str):
        self.calls.append(('disconnect', server_name))

    def refresh_server(self, server_name: str):
        self.calls.append(('refresh', server_name))
        return {'server_name': server_name, 'status': 'connected'}

    def test_connection(self, server_name: str):
        self.calls.append(('test', server_name))
        return {'success': True, 'message': 'ok', 'tool_count': 1}

    def get_server_status(self, server_name: str):
        self.calls.append(('status', server_name))
        return {'server_name': server_name, 'status': 'connected', 'tool_count': 1, 'error_message': ''}

    def call_tool(self, server_name: str, tool_name: str, arguments: dict):
        self.calls.append(('call_tool', server_name, tool_name, arguments))
        self.observability.append(get_current_execution_observability_fields())
        return {'success': True, 'data': {'results': arguments}, 'summary': tool_name}


class MCPExecutionAdapterTest(unittest.TestCase):
    def _build_adapter(self):
        service = ExecutionService(
            task_registry=TaskRegistry(),
            session_manager=_FakeSessionManager(),
            runner=InProcessExecutionRunner(),
        )
        return MCPExecutionAdapter(execution_service=service)

    def test_connect_server_wraps_manager_call(self) -> None:
        adapter = self._build_adapter()
        manager = _FakeManager()

        result = adapter.connect_server('demo', manager=manager)

        self.assertTrue(result['success'])
        self.assertEqual(result['status']['server_name'], 'demo')
        self.assertIn(('connect', 'demo'), manager.calls)


    def test_call_tool_allows_nested_session_task_under_running_agent(self) -> None:
        registry = TaskRegistry()
        registry.register_task(
            session_id='session-1',
            run_id='run-root',
            task='root-agent',
            status='running',
            execution_kind='agent_stream',
            concurrency_key='session:session-1',
        )
        service = ExecutionService(
            task_registry=registry,
            session_manager=_FakeSessionManager(),
            runner=InProcessExecutionRunner(),
        )
        adapter = MCPExecutionAdapter(execution_service=service)
        manager = _FakeManager()

        result = adapter.call_tool('demo', 'search', {'q': 'nested'}, manager=manager, session_id='session-1')

        self.assertTrue(result['success'])
        self.assertIn(('call_tool', 'demo', 'search', {'q': 'nested'}), manager.calls)
        session_status = registry.get_status('session-1')
        self.assertEqual(session_status['execution_kind'], 'agent_stream')

    def test_call_tool_wraps_manager_call(self) -> None:
        adapter = self._build_adapter()
        manager = _FakeManager()

        result = adapter.call_tool(
            'demo',
            'search',
            {'q': 'test'},
            manager=manager,
            session_id='session-1',
            run_id='run-1',
            request_id='req-1',
        )

        self.assertTrue(result['success'])
        self.assertEqual(result['data']['results'], {'q': 'test'})
        self.assertIn(('call_tool', 'demo', 'search', {'q': 'test'}), manager.calls)
        self.assertEqual(manager.observability[0]['session_id'], 'session-1')
        self.assertEqual(manager.observability[0]['run_id'], 'run-1')
        self.assertEqual(manager.observability[0]['request_id'], 'req-1')

    def test_call_tool_inherits_parent_run_and_request_ids(self) -> None:
        registry = TaskRegistry()
        service = ExecutionService(
            task_registry=registry,
            session_manager=_FakeSessionManager(),
            runner=InProcessExecutionRunner(),
        )
        adapter = MCPExecutionAdapter(execution_service=service)
        manager = _FakeManager()

        def outer_target(_context):
            return adapter.call_tool('demo', 'search', {'q': 'nested'}, manager=manager, session_id='session-outer')

        result = service.run(
            ExecutionRequest(
                execution_kind='agent_stream',
                session_id='session-outer',
                run_id='run-outer',
                request_id='req-outer',
            ),
            outer_target,
        )

        self.assertTrue(result.success)
        self.assertEqual(manager.observability[0]['session_id'], 'session-outer')
        self.assertEqual(manager.observability[0]['run_id'], 'run-outer')
        self.assertEqual(manager.observability[0]['request_id'], 'req-outer')
        self.assertEqual(manager.observability[0]['execution_kind'], 'mcp_tool_call')


if __name__ == '__main__':
    unittest.main()
