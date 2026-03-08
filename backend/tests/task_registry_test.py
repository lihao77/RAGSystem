# -*- coding: utf-8 -*-
"""TaskRegistry task-aware 扩展测试。"""

from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from agents.task_registry import TaskRegistry


class TaskRegistryTest(unittest.TestCase):
    def test_legacy_register_keeps_session_compatibility(self) -> None:
        registry = TaskRegistry()
        cancel_event = threading.Event()
        stop_event = threading.Event()
        ready = threading.Event()

        def worker() -> None:
            ready.set()
            stop_event.wait()

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(timeout=1))

        self.assertTrue(registry.register('session-1', 'run-1', 'legacy task', thread, cancel_event))
        status = registry.get_status('session-1')

        self.assertIsNotNone(status)
        self.assertEqual(status['status'], 'running')
        self.assertEqual(status['raw_status'], 'running')
        self.assertEqual(status['execution_kind'], 'agent_run')
        self.assertEqual(status['concurrency_key'], 'session:session-1')
        self.assertTrue(status['thread_alive'])
        self.assertTrue(bool(status['task_id']))

        stop_event.set()
        thread.join(timeout=1)
        registry.unregister('session-1', 'completed')

        finished = registry.get_status('session-1')
        self.assertEqual(finished['status'], 'completed')
        self.assertEqual(finished['raw_status'], 'completed')
        self.assertFalse(finished['thread_alive'])

    def test_register_task_supports_starting_and_mark_running(self) -> None:
        registry = TaskRegistry()
        cancel_event = threading.Event()
        stop_event = threading.Event()
        ready = threading.Event()

        task_id = registry.register_task(
            session_id='session-2',
            run_id='run-2',
            task='new task',
            status='starting',
            execution_kind='node_execute',
            concurrency_key='node:session-2',
            cancel_event=cancel_event,
        )
        self.assertIsNotNone(task_id)

        starting = registry.get_task_status(task_id)
        self.assertEqual(starting['status'], 'running')
        self.assertEqual(starting['raw_status'], 'starting')
        self.assertFalse(starting['thread_alive'])

        def worker() -> None:
            ready.set()
            stop_event.wait()

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(timeout=1))
        self.assertTrue(registry.mark_running(task_id, thread=thread))

        running = registry.get_task_status(task_id)
        self.assertEqual(running['status'], 'running')
        self.assertEqual(running['raw_status'], 'running')
        self.assertTrue(running['thread_alive'])

        stop_event.set()
        thread.join(timeout=1)
        self.assertTrue(registry.finish_task(task_id, status='completed'))

        completed = registry.get_task_status(task_id)
        self.assertEqual(completed['status'], 'completed')
        self.assertEqual(completed['raw_status'], 'completed')

    def test_concurrency_key_rejects_active_task(self) -> None:
        registry = TaskRegistry()
        stop_event = threading.Event()
        ready = threading.Event()

        def worker() -> None:
            ready.set()
            stop_event.wait()

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(timeout=1))

        first_task_id = registry.register_task(
            session_id='session-a',
            task='first',
            thread=thread,
            status='running',
            execution_kind='mcp_connect',
            concurrency_key='mcp:server:demo',
        )
        self.assertIsNotNone(first_task_id)

        second_task_id = registry.register_task(
            session_id='session-b',
            task='second',
            status='starting',
            execution_kind='mcp_connect',
            concurrency_key='mcp:server:demo',
        )
        self.assertIsNone(second_task_id)

        stop_event.set()
        thread.join(timeout=1)
        registry.finish_task(first_task_id, status='completed')

    def test_cancel_task_keeps_legacy_running_status_but_exposes_raw_status(self) -> None:
        registry = TaskRegistry()
        cancel_event = threading.Event()
        stop_event = threading.Event()
        ready = threading.Event()

        def worker() -> None:
            ready.set()
            stop_event.wait()

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(timeout=1))

        task_id = registry.register_task(
            session_id='session-3',
            run_id='run-3',
            task='cancel me',
            thread=thread,
            cancel_event=cancel_event,
            status='running',
            execution_kind='agent_stream',
            concurrency_key='session:session-3',
        )
        self.assertIsNotNone(task_id)

        approval_event = registry.add_pending_approval('session-3', 'approval-1')
        input_event = registry.add_pending_input('session-3', 'input-1')
        self.assertIsNotNone(approval_event)
        self.assertIsNotNone(input_event)

        self.assertTrue(registry.cancel('session-3'))
        self.assertTrue(cancel_event.is_set())
        self.assertTrue(approval_event.is_set())
        self.assertTrue(input_event.is_set())

        status = registry.get_status('session-3')
        self.assertEqual(status['status'], 'running')
        self.assertEqual(status['raw_status'], 'cancel_requested')

        approved, message = registry.get_approval_result('session-3', 'approval-1')
        self.assertFalse(approved)
        self.assertEqual(message, '')
        self.assertEqual(registry.get_input_result('session-3', 'input-1'), '')

        stop_event.set()
        thread.join(timeout=1)
        registry.finish_task(task_id, status='interrupted')




    def test_nested_session_task_without_session_concurrency_does_not_conflict(self) -> None:
        registry = TaskRegistry()
        root_task_id = registry.register_task(
            session_id='session-nested',
            run_id='run-root',
            task='root',
            status='running',
            execution_kind='agent_stream',
            concurrency_key='session:session-nested',
        )
        self.assertIsNotNone(root_task_id)

        nested_task_id = registry.register_task(
            session_id='session-nested',
            run_id='run-mcp',
            task='mcp-call',
            status='running',
            execution_kind='mcp_tool_call',
            concurrency_key=None,
        )
        self.assertIsNotNone(nested_task_id)
        self.assertNotEqual(root_task_id, nested_task_id)

        session_status = registry.get_status('session-nested')
        nested_status = registry.get_task_status(nested_task_id)
        self.assertEqual(session_status['task_id'], root_task_id)
        self.assertEqual(session_status['execution_kind'], 'agent_stream')
        self.assertEqual(nested_status['execution_kind'], 'mcp_tool_call')

    def test_task_level_approval_and_input_helpers(self) -> None:
        registry = TaskRegistry()
        task_id = registry.register_task(
            session_id='session-6',
            task='waiters',
            status='running',
            execution_kind='agent_stream',
            concurrency_key='session:session-6',
        )
        self.assertIsNotNone(task_id)

        approval_event = registry.add_task_pending_approval(task_id, 'approval-task-1')
        input_event = registry.add_task_pending_input(task_id, 'input-task-1')
        self.assertIsNotNone(approval_event)
        self.assertIsNotNone(input_event)

        self.assertTrue(registry.resolve_task_approval(task_id, 'approval-task-1', True, 'ok'))
        self.assertTrue(registry.resolve_task_input(task_id, 'input-task-1', 'hello'))
        self.assertTrue(approval_event.is_set())
        self.assertTrue(input_event.is_set())
        self.assertEqual(registry.get_task_approval_result(task_id, 'approval-task-1'), (True, 'ok'))
        self.assertEqual(registry.get_task_input_result(task_id, 'input-task-1'), 'hello')

    def test_task_subscription_cleanup_by_task_id(self) -> None:
        class _FakeBus:
            def __init__(self):
                self.unsubscribed = []

            def unsubscribe(self, subscription_id):
                self.unsubscribed.append(subscription_id)

        registry = TaskRegistry()
        task_id = registry.register_task(
            session_id='session-5',
            task='subs',
            status='running',
            execution_kind='agent_stream',
            concurrency_key='session:session-5',
        )
        self.assertIsNotNone(task_id)
        bus = _FakeBus()

        self.assertTrue(registry.set_task_persistent_subscriptions(task_id, ['a', 'b'], bus))
        registry.cleanup_task_subscriptions(task_id)

        self.assertEqual(bus.unsubscribed, ['a', 'b'])
        status = registry.get_task_status(task_id)
        self.assertEqual(status['raw_status'], 'running')

    def test_cleanup_finished_removes_task_and_session_index(self) -> None:
        registry = TaskRegistry()
        task_id = registry.register_task(
            session_id='session-4',
            task='cleanup',
            status='completed',
            execution_kind='node_execute',
        )
        self.assertIsNotNone(task_id)

        with registry._lock:
            registry._tasks_by_task_id[task_id].finished_at = time.time() - 360

        registry.cleanup_finished(max_age_seconds=300)

        self.assertIsNone(registry.get_task_status(task_id))
        self.assertIsNone(registry.get_status('session-4'))


if __name__ == '__main__':
    unittest.main()
