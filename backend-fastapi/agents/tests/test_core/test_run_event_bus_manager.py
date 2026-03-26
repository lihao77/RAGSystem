# -*- coding: utf-8 -*-

from agents.events.session_manager import RunEventBusManager


def test_cleanup_run_removes_bus_immediately():
    manager = RunEventBusManager(session_ttl=3600, cleanup_interval=9999, enable_persistence=True)
    try:
        manager.get_or_create('run-1', session_id='session-1')

        assert 'run-1' in manager.get_active_runs()
        assert manager.remove('run-1') is True
        assert 'run-1' not in manager.get_active_runs()
        assert manager.get('run-1') is None
    finally:
        manager.shutdown()


def test_remove_missing_run_returns_false():
    manager = RunEventBusManager(session_ttl=3600, cleanup_interval=9999, enable_persistence=True)
    try:
        assert manager.remove('missing-run') is False
    finally:
        manager.shutdown()
