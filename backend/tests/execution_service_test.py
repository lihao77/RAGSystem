# -*- coding: utf-8 -*-
"""ExecutionService 与 InProcessExecutionRunner 测试。"""

from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from agents.events.bus import EventBus, EventType
from agents.task_registry import TaskRegistry
from execution import ExecutionRequest, ExecutionStatus, InProcessExecutionRunner
from services.execution_service import ExecutionService


class _FakeSessionManager:
    def __init__(self):
        self.calls: list[str] = []
        self.buses: dict[str, object] = {}

    def get(self, session_id: str):
        return self.buses.get(session_id)

    def get_or_create(self, session_id: str):
        self.calls.append(session_id)
        bus = self.buses.get(session_id)
        if bus is None:
            bus = {'session_id': session_id}
            self.buses[session_id] = bus
        return bus


class ExecutionServiceTest(unittest.TestCase):
    def test_build_context_resolves_session_event_bus(self) -> None:
        session_manager = _FakeSessionManager()
        registry = TaskRegistry()
        service = ExecutionService(
            task_registry=registry,
            session_manager=session_manager,
            runner=InProcessExecutionRunner(),
        )

        context = service.build_context(
            ExecutionRequest(
                execution_kind='agent_stream',
                session_id='session-1',
                run_id='run-1',
                metadata={'alpha': 1},
            ),
            metadata={'beta': 2},
        )

        self.assertEqual(context.execution_kind, 'agent_stream')
        self.assertEqual(context.session_id, 'session-1')
        self.assertEqual(context.run_id, 'run-1')
        self.assertEqual(context.metadata, {'alpha': 1, 'beta': 2})
        self.assertEqual(context.event_bus, {'session_id': 'session-1'})
        self.assertIs(context.task_registry, registry)
        self.assertEqual(session_manager.calls, ['session-1'])
        self.assertFalse(context.cancel_event.is_set())
        self.assertTrue(bool(context.task_id))

    def test_get_status_by_session_reads_registry_snapshot(self) -> None:
        session_manager = _FakeSessionManager()
        registry = object()
        service = ExecutionService(
            task_registry=registry,
            session_manager=session_manager,
            runner=InProcessExecutionRunner(),
        )

        class _Registry:
            def get_status(self, session_id):
                return {'session_id': session_id, 'status': 'running', 'task_id': 'task-1'}

        service = ExecutionService(
            task_registry=_Registry(),
            session_manager=session_manager,
            runner=InProcessExecutionRunner(),
        )

        status = service.get_status_by_session('session-1')

        self.assertEqual(status['session_id'], 'session-1')
        self.assertEqual(status['task_id'], 'task-1')

    def test_cancel_session_publishes_interrupt_and_cancels_registry_task(self) -> None:
        class _Registry:
            def __init__(self):
                self.cancelled_task_id = None

            def get_status(self, session_id):
                return {'session_id': session_id, 'status': 'running', 'task_id': 'task-9'}

            def cancel_task(self, task_id):
                self.cancelled_task_id = task_id
                return True

            def get_task_status(self, task_id):
                return {'task_id': task_id, 'status': 'running'}

            def cleanup_finished(self, max_age_seconds=300):
                return None

        registry = _Registry()
        session_manager = _FakeSessionManager()
        event_bus = EventBus(enable_persistence=True)
        session_manager.buses['session-stop'] = event_bus
        service = ExecutionService(
            task_registry=registry,
            session_manager=session_manager,
            runner=InProcessExecutionRunner(),
        )

        ok = service.cancel_session('session-stop', reason='user_stop')

        self.assertTrue(ok)
        self.assertEqual(registry.cancelled_task_id, 'task-9')
        history = event_bus.get_event_history(limit=5)
        self.assertEqual(history[-1].type, EventType.USER_INTERRUPT)
        self.assertEqual(history[-1].data.get('reason'), 'user_stop')

    def test_submit_returns_handle_and_tracks_completion(self) -> None:
        service = ExecutionService(
            task_registry=TaskRegistry(),
            session_manager=_FakeSessionManager(),
            runner=InProcessExecutionRunner(),
        )

        handle = service.submit(
            ExecutionRequest(execution_kind='node_execute', payload=3),
            lambda context: context.payload + 4,
        )
        result = handle.join(timeout=1)

        self.assertIsNotNone(result)
        self.assertTrue(result.success)
        self.assertEqual(result.status, ExecutionStatus.COMPLETED)
        self.assertEqual(result.data, 7)

        status = service.get_status(handle.task_id)
        self.assertIsNotNone(status)
        self.assertEqual(status['status'], ExecutionStatus.COMPLETED.value)
        self.assertEqual(status['execution_kind'], 'node_execute')

    def test_cancel_marks_interrupted_when_target_exits_cooperatively(self) -> None:
        service = ExecutionService(
            task_registry=TaskRegistry(),
            session_manager=_FakeSessionManager(),
            runner=InProcessExecutionRunner(),
        )
        ready = threading.Event()

        def target(context):
            ready.set()
            while not context.cancel_event.is_set():
                time.sleep(0.01)
            return 'stopped'

        handle = service.submit(ExecutionRequest(execution_kind='agent_stream'), target)
        self.assertTrue(ready.wait(timeout=1))
        self.assertTrue(service.cancel(handle.task_id))
        result = handle.join(timeout=1)

        self.assertIsNotNone(result)
        self.assertEqual(result.status, ExecutionStatus.INTERRUPTED)
        self.assertEqual(result.data, 'stopped')


    def test_cleanup_finished_releases_completed_handles(self) -> None:
        registry = TaskRegistry()
        service = ExecutionService(
            task_registry=registry,
            session_manager=_FakeSessionManager(),
            runner=InProcessExecutionRunner(),
        )

        handle = service.submit(
            ExecutionRequest(execution_kind='node_execute', payload='cleanup-me'),
            lambda context: {'done': context.payload},
        )
        result = handle.join(timeout=1)
        self.assertTrue(result.success)

        before = service.get_status(handle.task_id)
        self.assertIsNotNone(before)

        service.cleanup_finished(max_age_seconds=300)

        self.assertNotIn(handle.task_id, service._handles)
        after = service.get_status(handle.task_id)
        self.assertIsNotNone(after)
        self.assertEqual(after['raw_status'], 'completed')

    def test_run_marks_timeout_and_sets_cancel_event(self) -> None:
        service = ExecutionService(
            task_registry=TaskRegistry(),
            session_manager=_FakeSessionManager(),
            runner=InProcessExecutionRunner(),
        )
        observed_cancel = threading.Event()

        def target(context):
            while not context.cancel_event.is_set():
                time.sleep(0.01)
            observed_cancel.set()
            return 'late-result'

        result = service.run(
            ExecutionRequest(execution_kind='mcp_tool_call', timeout_seconds=0.05),
            target,
        )

        self.assertEqual(result.status, ExecutionStatus.TIMED_OUT)
        self.assertFalse(result.success)
        self.assertEqual(result.error, 'execution timed out')
        self.assertTrue(observed_cancel.wait(timeout=1))


if __name__ == '__main__':
    unittest.main()
