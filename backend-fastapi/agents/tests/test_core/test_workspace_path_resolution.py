import sys
import shutil
import tempfile
import threading
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from types import SimpleNamespace

from tools.document_executor import read_file, write_file, edit_file
from tools.code_sandbox import execute_code_sandbox
from tools.path_resolution import get_code_execution_session_root, get_export_run_root
from tools.permissions import check_tool_permission
from tools.tool_registry import get_tool_registry
from tools.tool_executor_modules.dispatcher import _preprocess_document_tool_args, _execute_document_tool


def _make_temp_dir() -> Path:
    return Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))


def test_read_file_prefers_workspace_root_for_relative_paths():
    root = _make_temp_dir()
    workspace = root / "workspace"
    workspace.mkdir()
    target = workspace / "demo.txt"
    target.write_text("workspace-data\n", encoding="utf-8")

    try:
        result = read_file("demo.txt", workspace_root=str(workspace))

        assert result.success is True
        assert result.content == "workspace-data"
        assert result.metadata["file_path"] == str(target)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_write_file_without_path_uses_exports_space():
    session_id = "session-export-1"
    run_id = "run-export-1"
    expected_root = get_export_run_root(session_id, run_id)
    result = write_file(
        "hello",
        session_id=session_id,
        run_id=run_id,
        default_output_space="exports",
    )

    assert result.success is True
    output_path = Path(result.content["file_path"])
    assert output_path.parent == expected_root
    assert output_path.read_text(encoding="utf-8") == "hello"
    output_path.unlink(missing_ok=True)


def test_preprocess_document_tool_args_routes_relative_path_to_transient_when_space_specified():
    session_id = "session-space-transient"
    target = _preprocess_document_tool_args(
        "write_file",
        {"content": "hello", "file_path": "tmp.txt", "file_path_space": "transient"},
        workspace_root=None,
        default_output_space="workspace",
        session_id=session_id,
        run_id="run-space-transient",
        caller="direct",
    )

    assert Path(target["file_path"]).resolve().name == "tmp.txt"
    assert "sessions" in target["file_path"]
    assert f"{session_id}" in target["file_path"]
    assert "transient" in target["file_path"]


def test_preprocess_document_tool_args_consumes_file_path_space_after_resolution():
    session_id = "session-space-consumed"
    target = _preprocess_document_tool_args(
        "write_file",
        {"content": "hello", "file_path": "tmp.txt", "file_path_space": "transient"},
        workspace_root=None,
        default_output_space="workspace",
        session_id=session_id,
        run_id="run-space-consumed",
        caller="direct",
    )

    assert "file_path_space" not in target
    assert Path(target["file_path"]).resolve().name == "tmp.txt"
    assert f"{session_id}" in target["file_path"]
    assert "transient" in target["file_path"]


def test_execute_document_tool_write_file_accepts_xml_space_flattened_args_without_leaking_internal_field():
    session_id = "session-write-file-space"
    run_id = "run-write-file-space"

    import tools.tool_executor_modules.dispatcher as dispatcher_module

    original_get_fields = dispatcher_module.get_current_execution_observability_fields
    dispatcher_module.get_current_execution_observability_fields = lambda: {"run_id": run_id}
    try:
        result = _execute_document_tool(
            "write_file",
            {"content": "hello from xml attr", "file_path": "tmp.txt", "file_path_space": "transient"},
            caller="direct",
            session_id=session_id,
            agent_config=None,
        )
    finally:
        dispatcher_module.get_current_execution_observability_fields = original_get_fields

    assert result.success is True
    output_path = Path(result.content["file_path"])
    try:
        assert output_path.name == "tmp.txt"
        assert session_id in str(output_path)
        assert "transient" in str(output_path)
        assert output_path.read_text(encoding="utf-8") == "hello from xml attr"
    finally:
        output_path.unlink(missing_ok=True)


def test_edit_file_reads_existing_relative_file_from_workspace():
    root = _make_temp_dir()
    workspace = root / "workspace"
    workspace.mkdir()
    target = workspace / "note.txt"
    target.write_text("before\nafter\n", encoding="utf-8")

    try:
        result = edit_file(
            "note.txt",
            old_string="before",
            new_string="updated",
            workspace_root=str(workspace),
        )

        assert result.success is True
        assert target.read_text(encoding="utf-8") == "updated\nafter\n"
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_write_read_and_edit_file_support_explicit_transient_space():
    session_id = "session-direct-transient-space"
    run_id = "run-direct-transient-space"
    preprocessed = _preprocess_document_tool_args(
        "write_file",
        {"content": "before\nafter\n", "file_path": "note.txt", "file_path_space": "transient"},
        workspace_root=None,
        default_output_space="workspace",
        session_id=session_id,
        run_id=run_id,
        caller="direct",
    )

    write_result = write_file(
        preprocessed["content"],
        file_path=preprocessed["file_path"],
        session_id=session_id,
        run_id=run_id,
        default_output_space="workspace",
    )
    assert write_result.success is True

    try:
        read_args = _preprocess_document_tool_args(
            "read_file",
            {"file_path": "note.txt", "file_path_space": "transient"},
            workspace_root=None,
            default_output_space="workspace",
            session_id=session_id,
            run_id=run_id,
            caller="direct",
        )
        read_result = read_file(
            read_args["file_path"],
            session_id=session_id,
            run_id=run_id,
        )
        assert read_result.success is True
        assert read_result.content == "before\nafter"

        edit_args = _preprocess_document_tool_args(
            "edit_file",
            {"file_path": "note.txt", "file_path_space": "transient", "old_string": "before", "new_string": "updated"},
            workspace_root=None,
            default_output_space="workspace",
            session_id=session_id,
            run_id=run_id,
            caller="direct",
        )
        edit_result = edit_file(
            edit_args["file_path"],
            old_string=edit_args["old_string"],
            new_string=edit_args["new_string"],
            session_id=session_id,
            run_id=run_id,
        )
        assert edit_result.success is True

        updated_read = read_file(edit_args["file_path"], session_id=session_id, run_id=run_id)
        assert updated_read.content == "updated\nafter"
    finally:
        Path(preprocessed["file_path"]).unlink(missing_ok=True)


def test_preprocess_document_tool_args_keeps_workspace_as_default_relative_space():
    root = _make_temp_dir()
    workspace = root / "workspace"
    workspace.mkdir()

    try:
        args = _preprocess_document_tool_args(
            "write_file",
            {"content": "hello", "file_path": "note.txt"},
            workspace_root=str(workspace),
            default_output_space="transient",
            session_id="session-default-workspace",
            run_id="run-default-workspace",
            caller="direct",
        )
        assert Path(args["file_path"]).resolve() == (workspace / "note.txt").resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_execute_code_reads_workspace_and_writes_to_code_execution_root():
    root = _make_temp_dir()
    workspace = root / "workspace"
    workspace.mkdir()
    target = workspace / "sample.json"
    target.write_text('{"name": "workspace"}', encoding="utf-8")

    agent_config = SimpleNamespace(
        custom_params={
            "workspace_root": str(workspace),
            "default_output_space": "workspace",
        },
        tools=SimpleNamespace(enabled_tools=[]),
    )

    session_id = "session-code-root"
    code_root = get_code_execution_session_root(session_id)
    output_path = code_root / "result.txt"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.unlink(missing_ok=True)

    class _ApprovalRegistry:
        def __init__(self):
            self._events = {}
            self._results = {}

        def add_pending_approval(self, session_id, approval_id):
            event = threading.Event()
            self._events[(session_id, approval_id)] = event
            self._results[(session_id, approval_id)] = (False, "")
            return event

        def resolve_approval(self, session_id, approval_id, approved, message=""):
            self._results[(session_id, approval_id)] = (approved, message)
            self._events[(session_id, approval_id)].set()

        def get_approval_result(self, session_id, approval_id):
            return self._results[(session_id, approval_id)]

    registry = _ApprovalRegistry()

    class _EventBus:
        def publish(self, event):
            if getattr(event, "type", None) != "user.approval_required":
                return None

            def approve():
                registry.resolve_approval(event.session_id, event.data["approval_id"], True, "允许")

            threading.Thread(target=approve).start()
            return None

    try:
        from tools import code_sandbox as sandbox_module
        original_registry_getter = sandbox_module.get_task_registry
        sandbox_module.get_task_registry = lambda: registry

        result = execute_code_sandbox(
            code=(
                "content_a = open('sample.json', 'r').read()\n"
                "request_write_approval('result.txt', 'write temp result')\n"
                "with open('result.txt', 'w') as f:\n"
                "    f.write('generated')\n"
                "result = {'open': content_a, 'output_path': SANDBOX_DIR}"
            ),
            description="workspace path consistency",
            agent_config=agent_config,
            event_bus=_EventBus(),
            user_role=None,
            session_id=session_id,
        )

        assert result.success is True
        assert result.content["open"] == '{"name": "workspace"}'
        assert Path(result.content["output_path"]) == code_root
        assert output_path.exists()
        assert output_path.read_text(encoding="utf-8") == "generated"
    finally:
        sandbox_module.get_task_registry = original_registry_getter
        output_path.unlink(missing_ok=True)
        shutil.rmtree(root, ignore_errors=True)


def test_execute_code_rejects_document_file_tools():
    agent_config = SimpleNamespace(
        custom_params={},
        tools=SimpleNamespace(enabled_tools=["read_file"]),
    )

    result = execute_code_sandbox(
        code="result = call_tool('read_file', {'file_path': 'sample.json'})",
        description="reject read_file from code execution",
        agent_config=agent_config,
    )

    assert result.success is False
    assert "不允许从代码调用" in result.summary
    assert "caller code_execution" in result.summary


def test_document_file_tools_are_direct_only_for_permissions_and_registry():
    allowed_direct, direct_error = check_tool_permission("read_file", caller="direct")
    allowed_code, code_error = check_tool_permission("read_file", caller="code_execution")

    assert allowed_direct is True
    assert direct_error is None
    assert allowed_code is False
    assert code_error == "Tool read_file is not allowed from caller code_execution"

    code_callable_tools = get_tool_registry().get_code_callable_tools()
    assert "read_file" not in code_callable_tools
    assert "write_file" not in code_callable_tools
    assert "edit_file" not in code_callable_tools

