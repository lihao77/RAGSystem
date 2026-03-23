import sys
import shutil
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace

ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tools.auto_discovery import discover_decorated_tools
from tools.decorators import get_decorated_tools
from tools.document_executor import _prepare_document_tool_args, edit_file, read_file, write_file
from tools.code_sandbox import execute_code_sandbox
from tools.path_resolution import get_code_execution_session_root, get_export_run_root
from tools.permissions import check_tool_permission, _merge_decorated_permissions
from tools.tool_executor_modules.dispatcher import _merge_decorated_handlers
from tools.tool_registry import get_tool_registry


discover_decorated_tools()
_merge_decorated_handlers()
_merge_decorated_permissions()
get_tool_registry().register_extra_contracts([
    info["contract"] for info in get_decorated_tools().values()
])


def _make_document_agent_config(**custom_params):
    return SimpleNamespace(custom_params=custom_params)


def _make_temp_dir() -> Path:
    return Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))


def test_preprocess_document_tool_args_assigns_exports_path_when_file_path_missing():
    session_id = "session-export-1"
    run_id = "run-export-1"
    expected_root = get_export_run_root(session_id, run_id)

    args = _prepare_document_tool_args(
        "write_file",
        {"content": "hello"},
        caller="direct",
        session_id=session_id,
        run_id=run_id,
        agent_config=_make_document_agent_config(default_output_space="exports"),
    )
    result = write_file(
        args["content"],
        file_path=args["file_path"],
        caller="direct",
        session_id=session_id,
        run_id=run_id,
        agent_config=_make_document_agent_config(default_output_space="exports"),
    )

    assert result.success is True
    output_path = Path(result.content["file_path"])
    assert output_path.parent == expected_root
    assert output_path.read_text(encoding="utf-8") == "hello"
    output_path.unlink(missing_ok=True)


def test_preprocess_document_tool_args_routes_relative_path_to_transient_when_space_specified():
    session_id = "session-space-transient"
    target = _prepare_document_tool_args(
        "write_file",
        {"content": "hello", "file_path": "tmp.txt", "file_path_space": "transient"},
        caller="direct",
        session_id=session_id,
        run_id="run-space-transient",
        agent_config=_make_document_agent_config(default_output_space="workspace"),
    )

    assert Path(target["file_path"]).resolve().name == "tmp.txt"
    assert "sessions" in target["file_path"]
    assert f"{session_id}" in target["file_path"]
    assert "transient" in target["file_path"]


def test_preprocess_document_tool_args_consumes_file_path_space_after_resolution():
    session_id = "session-space-consumed"
    target = _prepare_document_tool_args(
        "write_file",
        {"content": "hello", "file_path": "tmp.txt", "file_path_space": "transient"},
        caller="direct",
        session_id=session_id,
        run_id="run-space-consumed",
        agent_config=_make_document_agent_config(default_output_space="workspace"),
    )

    assert "file_path_space" not in target
    assert Path(target["file_path"]).resolve().name == "tmp.txt"
    assert f"{session_id}" in target["file_path"]
    assert "transient" in target["file_path"]


def test_execute_document_tool_write_file_accepts_xml_space_flattened_args_without_leaking_internal_field():
    session_id = "session-write-file-space"
    run_id = "run-write-file-space"

    import tools.document_executor as document_executor_module

    original_get_fields = document_executor_module.get_current_execution_observability_fields
    document_executor_module.get_current_execution_observability_fields = lambda: {"run_id": run_id}
    try:
        result = write_file(
            content="hello from xml attr",
            file_path="tmp.txt",
            file_path_space="transient",
            caller="direct",
            session_id=session_id,
        )
    finally:
        document_executor_module.get_current_execution_observability_fields = original_get_fields

    assert result.success is True
    output_path = Path(result.content["file_path"])
    try:
        assert output_path.name == "tmp.txt"
        assert session_id in str(output_path)
        assert "transient" in str(output_path)
        assert output_path.read_text(encoding="utf-8") == "hello from xml attr"
    finally:
        output_path.unlink(missing_ok=True)


def test_preprocess_document_tool_args_keeps_workspace_as_default_relative_space():
    root = _make_temp_dir()
    workspace = root / "workspace"
    workspace.mkdir()

    try:
        args = _prepare_document_tool_args(
            "write_file",
            {"content": "hello", "file_path": "note.txt"},
            caller="direct",
            session_id="session-default-workspace",
            run_id="run-default-workspace",
            agent_config=_make_document_agent_config(
                workspace_root=str(workspace),
                default_output_space="transient",
            ),
        )
        assert Path(args["file_path"]).resolve() == (workspace / "note.txt").resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_preprocess_document_tool_args_accepts_absolute_path_inside_workspace_root(caplog):
    import logging

    root = _make_temp_dir()
    workspace = root / "workspace"
    workspace.mkdir()
    target = workspace / "note.txt"
    target.write_text("hello", encoding="utf-8")

    try:
        caplog.set_level(logging.DEBUG)
        args = _prepare_document_tool_args(
            "edit_file",
            {"file_path": str(target), "old_string": "hello", "new_string": "world"},
            caller="direct",
            session_id="session-absolute-workspace",
            run_id="run-absolute-workspace",
            agent_config=_make_document_agent_config(
                workspace_root=str(workspace),
                default_output_space="workspace",
            ),
        )
        assert Path(args["file_path"]).resolve() == target.resolve()
        assert "文档工具路径预处理开始" in caplog.text
        assert str(workspace.resolve()) in caplog.text
        assert str(target.resolve()) in caplog.text
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_read_file_uses_preprocessed_workspace_absolute_path():
    root = _make_temp_dir()
    workspace = root / "workspace"
    workspace.mkdir()
    target = workspace / "demo.txt"
    target.write_text("workspace-data\n", encoding="utf-8")

    try:
        args = _prepare_document_tool_args(
            "read_file",
            {"file_path": "demo.txt"},
            caller="direct",
            session_id="session-read-workspace",
            run_id="run-read-workspace",
            agent_config=_make_document_agent_config(
                workspace_root=str(workspace),
                default_output_space="workspace",
            ),
        )
        result = read_file(
            args["file_path"],
            caller="direct",
            session_id="session-read-workspace",
            run_id="run-read-workspace",
            agent_config=_make_document_agent_config(
                workspace_root=str(workspace),
                default_output_space="workspace",
            ),
        )

        assert result.success is True
        assert result.content == "workspace-data"
        assert result.metadata["file_path"] == str(target)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_edit_file_uses_preprocessed_workspace_absolute_path():
    root = _make_temp_dir()
    workspace = root / "workspace"
    workspace.mkdir()
    target = workspace / "note.txt"
    target.write_text("before\nafter\n", encoding="utf-8")

    try:
        args = _prepare_document_tool_args(
            "edit_file",
            {"file_path": "note.txt", "old_string": "before", "new_string": "updated"},
            caller="direct",
            session_id="session-edit-workspace",
            run_id="run-edit-workspace",
            agent_config=_make_document_agent_config(
                workspace_root=str(workspace),
                default_output_space="workspace",
            ),
        )
        result = edit_file(
            args["file_path"],
            old_string=args["old_string"],
            new_string=args["new_string"],
            caller="direct",
            session_id="session-edit-workspace",
            run_id="run-edit-workspace",
            agent_config=_make_document_agent_config(
                workspace_root=str(workspace),
                default_output_space="workspace",
            ),
        )

        assert result.success is True
        assert target.read_text(encoding="utf-8") == "updated\nafter\n"
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_write_read_and_edit_file_support_explicit_transient_space():
    session_id = "session-direct-transient-space"
    run_id = "run-direct-transient-space"
    preprocessed = _prepare_document_tool_args(
        "write_file",
        {"content": "before\nafter\n", "file_path": "note.txt", "file_path_space": "transient"},
        caller="direct",
        session_id=session_id,
        run_id=run_id,
        agent_config=_make_document_agent_config(default_output_space="workspace"),
    )

    write_result = write_file(
        preprocessed["content"],
        file_path=preprocessed["file_path"],
        caller="direct",
        session_id=session_id,
        run_id=run_id,
        agent_config=_make_document_agent_config(default_output_space="workspace"),
    )
    assert write_result.success is True

    try:
        read_args = _prepare_document_tool_args(
            "read_file",
            {"file_path": "note.txt", "file_path_space": "transient"},
            caller="direct",
            session_id=session_id,
            run_id=run_id,
            agent_config=_make_document_agent_config(default_output_space="workspace"),
        )
        read_result = read_file(
            read_args["file_path"],
            caller="direct",
            session_id=session_id,
            run_id=run_id,
            agent_config=_make_document_agent_config(default_output_space="workspace"),
        )
        assert read_result.success is True
        assert read_result.content == "before\nafter"

        edit_args = _prepare_document_tool_args(
            "edit_file",
            {"file_path": "note.txt", "file_path_space": "transient", "old_string": "before", "new_string": "updated"},
            caller="direct",
            session_id=session_id,
            run_id=run_id,
            agent_config=_make_document_agent_config(default_output_space="workspace"),
        )
        edit_result = edit_file(
            edit_args["file_path"],
            old_string=edit_args["old_string"],
            new_string=edit_args["new_string"],
            caller="direct",
            session_id=session_id,
            run_id=run_id,
            agent_config=_make_document_agent_config(default_output_space="workspace"),
        )
        assert edit_result.success is True

        updated_read = read_file(
            edit_args["file_path"],
            caller="direct",
            session_id=session_id,
            run_id=run_id,
            agent_config=_make_document_agent_config(default_output_space="workspace"),
        )
        assert updated_read.content == "updated\nafter"
    finally:
        Path(preprocessed["file_path"]).unlink(missing_ok=True)


def test_execute_code_uses_workspace_for_reads_and_sandbox_for_writes():
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
    assert "Tool read_file is not allowed from caller code_execution" in result.summary


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
