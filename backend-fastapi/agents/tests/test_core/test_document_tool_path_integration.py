import threading
from pathlib import Path
from types import SimpleNamespace
import sys

ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from agents.task_registry import TaskRegistry
from tools.document_executor import FILE_SIZE_PREVIEW_THRESHOLD
from tools.path_resolution import get_export_run_root
from tools.tool_executor_modules.dispatcher import _execute_document_tool


def _set_run_id(monkeypatch, run_id: str):
    import tools.tool_executor_modules.dispatcher as dispatcher_module

    monkeypatch.setattr(
        dispatcher_module,
        "get_current_execution_observability_fields",
        lambda: {"run_id": run_id},
    )


def _track_resolve_calls(monkeypatch):
    import tools.path_resolution as path_resolution

    original = path_resolution.resolve_managed_path
    calls = []

    def wrapped(file_path, **kwargs):
        calls.append({"file_path": file_path, **kwargs})
        return original(file_path, **kwargs)

    monkeypatch.setattr(path_resolution, "resolve_managed_path", wrapped)
    return calls


def _prepare_registry(monkeypatch, session_id: str):
    registry = TaskRegistry()
    registry.register_task(session_id=session_id, run_id="test-run", task="document-tool-path-test", status="running")
    monkeypatch.setattr("agents.task_registry.get_task_registry", lambda: registry)
    return registry


def test_execute_document_tool_edit_file_resolves_path_once(monkeypatch, tmp_path):
    file_path = tmp_path / "note.txt"
    file_path.write_text("before\nafter\n", encoding="utf-8")

    calls = _track_resolve_calls(monkeypatch)
    _set_run_id(monkeypatch, "run-edit")
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(tmp_path)})

    result = _execute_document_tool(
        "edit_file",
        {"file_path": "note.txt", "old_string": "before", "new_string": "updated"},
        caller="direct",
        session_id="session-edit",
        agent_config=agent_config,
    )

    assert result.success is True
    assert file_path.read_text(encoding="utf-8") == "updated\nafter\n"
    assert len(calls) == 1
    assert calls[0]["file_path"] == "note.txt"
    assert calls[0]["operation"] == "edit"


def test_execute_document_tool_write_file_allocates_output_once_when_path_missing(monkeypatch):
    session_id = "session-write"
    run_id = "run-write"
    expected_root = get_export_run_root(session_id, run_id)

    calls = _track_resolve_calls(monkeypatch)
    _set_run_id(monkeypatch, run_id)
    agent_config = SimpleNamespace(custom_params={"default_output_space": "exports"})

    result = _execute_document_tool(
        "write_file",
        {"content": "hello"},
        caller="direct",
        session_id=session_id,
        agent_config=agent_config,
    )

    assert result.success is True
    output_path = Path(result.content["file_path"])
    try:
        assert output_path.parent == expected_root
        assert output_path.read_text(encoding="utf-8") == "hello"
        assert len(calls) == 1
        assert calls[0]["file_path"] is None
        assert calls[0]["operation"] == "write"
    finally:
        output_path.unlink(missing_ok=True)


def test_execute_document_tool_read_file_resolves_path_once_and_keeps_large_file_approval(monkeypatch, tmp_path):
    session_id = "session-read"
    run_id = "run-read"
    file_path = tmp_path / "large.txt"
    file_path.write_text("A" * (FILE_SIZE_PREVIEW_THRESHOLD + 512), encoding="utf-8")

    calls = _track_resolve_calls(monkeypatch)
    _set_run_id(monkeypatch, run_id)
    registry = _prepare_registry(monkeypatch, session_id)
    published = {}

    class _EventBus:
        def publish(self, event):
            published["event"] = event
            approval_id = event.data["approval_id"]

            def approve():
                registry.resolve_approval(session_id, approval_id, True, "")

            threading.Thread(target=approve).start()
            return None

    agent_config = SimpleNamespace(custom_params={"workspace_root": str(tmp_path)})
    result = _execute_document_tool(
        "read_file",
        {"file_path": "large.txt"},
        caller="direct",
        event_bus=_EventBus(),
        session_id=session_id,
        agent_config=agent_config,
    )

    assert result.success is True
    assert result.metadata["user_approved_full_read"] is True
    assert published["event"].data["preview_threshold"] == FILE_SIZE_PREVIEW_THRESHOLD
    assert len(calls) == 1
    assert calls[0]["file_path"] == "large.txt"
    assert calls[0]["operation"] == "read"
