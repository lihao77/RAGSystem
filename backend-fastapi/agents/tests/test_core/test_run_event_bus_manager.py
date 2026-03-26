# -*- coding: utf-8 -*-

from agents.events.session_manager import RunEventBusManager


def test_run_end_marks_run_for_short_ttl_cleanup():
    manager = RunEventBusManager(session_ttl=3600, cleanup_interval=9999, ended_run_ttl=0, enable_persistence=True)
    try:
        manager.get_or_create('run-1', session_id='session-1')
        manager.mark_run_ended('run-1')

        assert 'run-1' in manager.get_active_runs()
        manager._cleanup_expired_runs()
        assert 'run-1' not in manager.get_active_runs()
    finally:
        manager.shutdown()
