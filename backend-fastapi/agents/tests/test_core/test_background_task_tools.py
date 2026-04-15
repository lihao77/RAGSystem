# -*- coding: utf-8 -*-

import shutil
import tempfile
import time
from pathlib import Path

from tools.local.task_tools import task_output, task_stop
from tools.runtime.background_tasks import get_background_task_manager


def _make_temp_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="background-task-tools-"))


def test_task_output_returns_running_snapshot_without_blocking():
    temp_dir = _make_temp_dir()
    try:
        bg_manager = get_background_task_manager()
        bg_manager._tasks.clear()
        bg_manager._processes.clear()

        task = bg_manager.spawn_bash(
            "sleep 2",
            bash_executable=None,
            cwd=temp_dir,
            output_dir=temp_dir,
            session_id="session-1",
        )

        result = task_output(task.task_id, block=False)

        assert result.success is True
        assert result.content["task_id"] == task.task_id
        assert result.content["status"] in {"running", "completed", "failed", "cancelled"}
        assert result.content["completed"] in {True, False}
        assert result.metadata["task_id"] == task.task_id
    finally:
        bg_manager.cancel(task.task_id)
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_task_output_blocking_returns_wait_signal_for_running_task():
    temp_dir = _make_temp_dir()
    try:
        bg_manager = get_background_task_manager()
        bg_manager._tasks.clear()
        bg_manager._processes.clear()

        task = bg_manager.spawn_bash(
            "sleep 2",
            bash_executable=None,
            cwd=temp_dir,
            output_dir=temp_dir,
            session_id="session-1",
        )

        result = task_output(task.task_id, block=True, timeout=42000)

        assert result.success is True
        assert result.content["background_task_id"] == task.task_id
        assert result.content["suggest_wait"] is True
        assert result.content["wait_timeout_ms"] == 42000
        assert result.metadata["wait_timeout_ms"] == 42000
    finally:
        bg_manager.cancel(task.task_id)
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_task_output_parses_completed_callable_json_payload():
    temp_dir = _make_temp_dir()
    try:
        bg_manager = get_background_task_manager()
        bg_manager._tasks.clear()
        bg_manager._processes.clear()

        task = bg_manager.submit_callable(
            lambda: {"answer": 42},
            description="callable result",
            output_dir=temp_dir,
            session_id="session-1",
        )

        for _ in range(50):
            current = bg_manager.get_task(task.task_id)
            if current and current.is_done():
                break
            time.sleep(0.01)
        else:
            raise AssertionError("background callable did not finish")

        result = task_output(task.task_id, block=False)

        assert result.success is True
        assert result.content["completed"] is True
        assert result.content["result_type"] == "dict"
        assert result.content["output"] == {"success": True, "result_type": "dict", "result": {"answer": 42}}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_task_stop_cancels_bash_task():
    temp_dir = _make_temp_dir()
    try:
        bg_manager = get_background_task_manager()
        bg_manager._tasks.clear()
        bg_manager._processes.clear()

        task = bg_manager.spawn_bash(
            "sleep 2",
            bash_executable=None,
            cwd=temp_dir,
            output_dir=temp_dir,
            session_id="session-1",
        )

        result = task_stop(task.task_id)

        assert result.success is True
        assert result.content["stop_requested"] is True
        assert result.content["current_status"] == "cancelled"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_task_stop_rejects_non_cancellable_callable_task():
    temp_dir = _make_temp_dir()
    try:
        bg_manager = get_background_task_manager()
        bg_manager._tasks.clear()
        bg_manager._processes.clear()

        task = bg_manager.submit_callable(
            lambda: time.sleep(0.2),
            description="sleep callable",
            output_dir=temp_dir,
            session_id="session-1",
        )

        result = task_stop(task.task_id)

        assert result.success is False
        assert "不支持可靠停止" in result.summary
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
