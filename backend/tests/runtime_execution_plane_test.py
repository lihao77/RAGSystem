# -*- coding: utf-8 -*-
"""执行平面 runtime getter 测试。"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

import agents.core.orchestrator as orchestrator_module
import agents.events.bus as event_bus_module
import agents.events.session_manager as session_manager_module
import agents.task_registry as task_registry_module
import mcp.client_manager as mcp_client_manager_module
import services.execution_service as execution_service_module
from runtime.container import RuntimeContainer, get_current_runtime_container, set_current_runtime_container
from runtime.dependencies import get_runtime_fallback_stats, reset_runtime_fallback_tracking


class RuntimeExecutionPlaneTest(unittest.TestCase):
    def setUp(self) -> None:
        self._previous_strict = os.environ.get('RAGSYSTEM_RUNTIME_STRICT')
        os.environ.pop('RAGSYSTEM_RUNTIME_STRICT', None)
        self._reset_runtime_state()

    def tearDown(self) -> None:
        if self._previous_strict is None:
            os.environ.pop('RAGSYSTEM_RUNTIME_STRICT', None)
        else:
            os.environ['RAGSYSTEM_RUNTIME_STRICT'] = self._previous_strict
        self._reset_runtime_state()

    def _reset_runtime_state(self) -> None:
        container = get_current_runtime_container()
        if container is not None:
            try:
                container.shutdown()
            except Exception:
                pass
        set_current_runtime_container(None)

        manager = getattr(session_manager_module, '_global_session_manager', None)
        if manager is not None:
            try:
                manager.shutdown()
            except Exception:
                pass
        session_manager_module._global_session_manager = None
        orchestrator_module._global_orchestrator = None
        task_registry_module._registry = None
        execution_service_module._execution_service = None
        mcp_client_manager_module._manager_instance = None
        event_bus_module._global_event_bus = None
        event_bus_module._current_event_bus.set(None)
        reset_runtime_fallback_tracking()

    def test_task_registry_prefers_container_instance(self) -> None:
        container = RuntimeContainer()
        expected = task_registry_module.TaskRegistry()
        container.set_instance('task_registry', expected)
        set_current_runtime_container(container)

        result = task_registry_module.get_task_registry()

        self.assertIs(result, expected)
        self.assertEqual(get_runtime_fallback_stats(), [])

    def test_orchestrator_prefers_container_instance(self) -> None:
        class FakeRuntimeService:
            def __init__(self, orchestrator):
                self._orchestrator = orchestrator

            def get_orchestrator(self):
                return self._orchestrator

        container = RuntimeContainer()
        expected = object()
        set_current_runtime_container(container)

        with patch.object(
            container,
            'get_agent_runtime_service',
            return_value=FakeRuntimeService(expected),
        ):
            result = orchestrator_module.get_orchestrator()

        self.assertIs(result, expected)
        self.assertEqual(get_runtime_fallback_stats(), [])

    def test_orchestrator_requires_container(self) -> None:
        def invoke_orchestrator():
            return orchestrator_module.get_orchestrator()

        with self.assertRaises(RuntimeError) as context:
            invoke_orchestrator()

        message = str(context.exception)
        self.assertIn('agent_orchestrator', message)
        self.assertIn('invoke_orchestrator', message)
        self.assertEqual(get_runtime_fallback_stats(), [])

    def test_session_manager_prefers_container_and_keeps_config(self) -> None:
        container = RuntimeContainer()
        set_current_runtime_container(container)

        manager = session_manager_module.get_session_manager(
            session_ttl=5,
            cleanup_interval=7,
            enable_persistence=False,
            max_history=9,
        )
        event_bus = session_manager_module.get_session_event_bus('session-1')

        self.assertIs(manager, container.get_instance('session_manager'))
        self.assertEqual(manager.session_ttl, 5)
        self.assertEqual(manager.cleanup_interval, 7)
        self.assertFalse(manager.enable_persistence)
        self.assertEqual(manager.max_history, 9)
        self.assertIs(manager.get('session-1'), event_bus)
        self.assertEqual(get_runtime_fallback_stats(), [])

    def test_task_registry_strict_mode_raises_without_container(self) -> None:
        os.environ['RAGSYSTEM_RUNTIME_STRICT'] = '1'

        def invoke_registry():
            return task_registry_module.get_task_registry()

        with self.assertRaises(RuntimeError) as context:
            invoke_registry()

        message = str(context.exception)
        self.assertIn('task_registry', message)
        self.assertIn('invoke_registry', message)
        self.assertEqual(get_runtime_fallback_stats(), [])

    def test_session_event_bus_strict_mode_raises_without_container(self) -> None:
        os.environ['RAGSYSTEM_RUNTIME_STRICT'] = '1'

        def invoke_event_bus():
            return session_manager_module.get_session_event_bus('session-2')

        with self.assertRaises(RuntimeError) as context:
            invoke_event_bus()

        message = str(context.exception)
        self.assertIn('session_manager', message)
        self.assertIn('get_session_event_bus', message)
        self.assertEqual(get_runtime_fallback_stats(), [])


    def test_mcp_manager_prefers_container_instance(self) -> None:
        class FakeStore:
            def list_servers(self):
                return []

            def get_server(self, _server_name):
                return None

        container = RuntimeContainer()
        expected = mcp_client_manager_module.MCPClientManager(store=FakeStore())
        container.set_instance('mcp_manager', expected)
        set_current_runtime_container(container)

        result = mcp_client_manager_module.get_mcp_manager()

        self.assertIs(result, expected)
        self.assertEqual(get_runtime_fallback_stats(), [])

    def test_mcp_manager_strict_mode_raises_without_container(self) -> None:
        os.environ['RAGSYSTEM_RUNTIME_STRICT'] = '1'

        def invoke_manager():
            return mcp_client_manager_module.get_mcp_manager()

        with self.assertRaises(RuntimeError) as context:
            invoke_manager()

        message = str(context.exception)
        self.assertIn('mcp_manager', message)
        self.assertIn('invoke_manager', message)
        self.assertEqual(get_runtime_fallback_stats(), [])


    def test_execution_service_prefers_container_instance(self) -> None:
        container = RuntimeContainer()
        expected = execution_service_module.ExecutionService(
            task_registry=object(),
            session_manager=object(),
            runner=object(),
        )
        container.set_instance('execution_service', expected)
        set_current_runtime_container(container)

        result = execution_service_module.get_execution_service()

        self.assertIs(result, expected)
        self.assertEqual(get_runtime_fallback_stats(), [])


    def test_event_bus_prefers_container_instance(self) -> None:
        container = RuntimeContainer()
        expected = event_bus_module.EventBus(enable_persistence=True)
        container.set_instance('event_bus', expected)
        set_current_runtime_container(container)

        result = event_bus_module.get_event_bus(enable_persistence=False)

        self.assertIs(result, expected)
        self.assertEqual(get_runtime_fallback_stats(), [])

    def test_event_bus_strict_mode_raises_without_container(self) -> None:
        os.environ['RAGSYSTEM_RUNTIME_STRICT'] = '1'

        def invoke_event_bus():
            return event_bus_module.get_event_bus()

        with self.assertRaises(RuntimeError) as context:
            invoke_event_bus()

        message = str(context.exception)
        self.assertIn('event_bus', message)
        self.assertIn('invoke_event_bus', message)
        self.assertEqual(get_runtime_fallback_stats(), [])


if __name__ == '__main__':
    unittest.main()
