# -*- coding: utf-8 -*-

import json
import shutil
import tempfile
import time
from pathlib import Path

from tools.contracts.result_models import ToolExecutionResult
from tools.runtime.background_tasks import get_background_task_manager


def _make_temp_dir() -> Path:
    return Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))


def test_submit_callable_serializes_tool_execution_result():
    temp_dir = _make_temp_dir()
    try:
        bg_manager = get_background_task_manager()
        bg_manager._tasks.clear()
        bg_manager._processes.clear()

        task = bg_manager.submit_callable(
            lambda: ToolExecutionResult(
                success=True,
                tool_name="demo_tool",
                summary="done",
                output_type="json",
                content={"value": 1},
                metadata={"source": "test"},
            ),
            description="serialize tool result",
            output_dir=temp_dir,
            session_id="session-1",
            run_id="run-1",
            owner_task_id="task-1",
        )

        for _ in range(50):
            current = bg_manager.get_task(task.task_id)
            if current and current.is_done():
                break
            time.sleep(0.01)
        else:
            raise AssertionError("background callable did not finish")

        current = bg_manager.get_task(task.task_id)
        assert current is not None
        assert current.status == "completed"
        assert current.result_type == "tool_execution_result"

        payload = json.loads(bg_manager.get_output(task.task_id))
        assert payload == {
            "success": True,
            "result_type": "tool_execution_result",
            "result": {
                "success": True,
                "tool_name": "demo_tool",
                "summary": "done",
                "answer": None,
                "output_type": "json",
                "content": {"value": 1},
                "metadata": {"source": "test"},
                "artifacts": [],
                "llm_hint": None,
            },
        }
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)



def test_submit_callable_serializes_exception_payload():
    temp_dir = _make_temp_dir()
    try:
        bg_manager = get_background_task_manager()
        bg_manager._tasks.clear()
        bg_manager._processes.clear()

        task = bg_manager.submit_callable(
            lambda: (_ for _ in ()).throw(ValueError("boom")),
            description="raise error",
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

        current = bg_manager.get_task(task.task_id)
        assert current is not None
        assert current.status == "failed"
        assert current.result_type == "exception"

        payload = json.loads(bg_manager.get_output(task.task_id))
        assert payload["success"] is False
        assert payload["result_type"] == "exception"
        assert payload["error"] == "boom"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
