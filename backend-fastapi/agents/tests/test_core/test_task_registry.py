# -*- coding: utf-8 -*-

import threading

from agents.task_registry import TaskRegistry


def test_get_task_id_by_session_returns_bound_task_id():
    registry = TaskRegistry()
    task_id = registry.register_task(
        session_id='session-1',
        run_id='run-1',
        task='demo',
        thread=threading.current_thread(),
        status='running',
        execution_kind='agent_run',
        concurrency_key='session:session-1',
    )

    assert task_id is not None
    assert registry.get_task_id_by_session('session-1') == task_id


def test_add_pending_input_uses_session_task_mapping():
    registry = TaskRegistry()
    task_id = registry.register_task(
        session_id='session-1',
        run_id='run-1',
        task='demo',
        thread=threading.current_thread(),
        status='running',
        execution_kind='agent_run',
        concurrency_key='session:session-1',
    )

    wait_evt = registry.add_pending_input('session-1', 'input-1')

    assert task_id is not None
    assert wait_evt is not None
    snapshot = registry.get_task_status(task_id)
    assert snapshot['task_id'] == task_id


def test_add_pending_approval_uses_session_task_mapping():
    registry = TaskRegistry()
    task_id = registry.register_task(
        session_id='session-1',
        run_id='run-1',
        task='demo',
        thread=threading.current_thread(),
        status='running',
        execution_kind='agent_run',
        concurrency_key='session:session-1',
    )

    wait_evt = registry.add_pending_approval('session-1', 'approval-1')

    assert task_id is not None
    assert wait_evt is not None
    snapshot = registry.get_task_status(task_id)
    assert snapshot['task_id'] == task_id
