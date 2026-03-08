# -*- coding: utf-8 -*-
"""NodeExecutionAdapter 测试。"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from agents.task_registry import TaskRegistry
from execution import InProcessExecutionRunner
from execution.adapters.node_execution import NodeExecutionAdapter
from execution.observability import get_current_execution_observability_fields
from services.execution_service import ExecutionService


class _FakeSessionManager:
    def get_or_create(self, session_id: str):
        return {'session_id': session_id}


class _FakeNodeService:
    def __init__(self, result=None, error=None, sleep_seconds: float = 0.0):
        self._result = result
        self._error = error
        self._sleep_seconds = sleep_seconds
        self.calls = []
        self.observability = []

    def execute_node(self, payload):
        self.calls.append(payload)
        self.observability.append(get_current_execution_observability_fields())
        if self._sleep_seconds:
            time.sleep(self._sleep_seconds)
        if self._error is not None:
            raise self._error
        return self._result


class NodeExecutionAdapterTest(unittest.TestCase):
    def _build_adapter(self):
        service = ExecutionService(
            task_registry=TaskRegistry(),
            session_manager=_FakeSessionManager(),
            runner=InProcessExecutionRunner(),
        )
        return NodeExecutionAdapter(execution_service=service)

    def test_execute_returns_node_outputs(self) -> None:
        adapter = self._build_adapter()
        node_service = _FakeNodeService(result={'answer': 42})

        result = adapter.execute(
            {'node_type': 'demo', 'inputs': {'x': 1}},
            node_service=node_service,
            session_id='session-node',
            run_id='run-node',
            request_id='req-node',
        )

        self.assertEqual(result, {'answer': 42})
        self.assertEqual(node_service.calls[0]['node_type'], 'demo')
        self.assertEqual(node_service.observability[0]['session_id'], 'session-node')
        self.assertEqual(node_service.observability[0]['run_id'], 'run-node')
        self.assertEqual(node_service.observability[0]['request_id'], 'req-node')
        self.assertEqual(node_service.observability[0]['execution_kind'], 'node_execute')

    def test_execute_re_raises_service_error(self) -> None:
        adapter = self._build_adapter()
        error = ValueError('bad node config')
        node_service = _FakeNodeService(error=error)

        with self.assertRaises(ValueError) as context:
            adapter.execute({'node_type': 'demo'}, node_service=node_service)

        self.assertIs(context.exception, error)

    def test_execute_raises_timeout_error(self) -> None:
        adapter = self._build_adapter()
        node_service = _FakeNodeService(result={'late': True}, sleep_seconds=0.05)

        with self.assertRaises(TimeoutError):
            adapter.execute({'node_type': 'demo', 'timeout_seconds': 0.01}, node_service=node_service)


if __name__ == '__main__':
    unittest.main()
