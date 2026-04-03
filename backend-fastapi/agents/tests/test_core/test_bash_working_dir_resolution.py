# -*- coding: utf-8 -*-

import sys
import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from execution.observability import (
    ExecutionObservabilityContext,
    execution_observability_scope,
)
from tools.local.bash_tool import (
    VALIDATION_ALLOWED,
    VALIDATION_APPROVAL_REQUIRED,
    _resolve_work_dir,
    _split_shell_pipeline,
    _validate_command,
    execute_bash,
)


def test_split_shell_pipeline_preserves_regex_pipe_inside_double_quotes():
    command = 'find . -name "*.json" | grep -i "nanning\\|南宁\\|boundary\\|admin" | head -20'

    segments = _split_shell_pipeline(command)

    assert segments == [
        'find . -name "*.json" ',
        ' grep -i "nanning\\|南宁\\|boundary\\|admin" ',
        ' head -20',
    ]


def test_validate_command_allows_escaped_regex_pipe_in_grep_pattern():
    command = 'find . -name "*.json" | grep -i "nanning\\|南宁\\|boundary\\|admin" | head -20'

    status, err, approval_commands, classification = _validate_command(command)

    assert status == VALIDATION_ALLOWED
    assert err == ""
    assert approval_commands == []


def test_validate_command_still_marks_non_whitelisted_pipeline_command_for_approval():
    status, err, approval_commands, classification = _validate_command('find . -name "*.json" | python -V')

    assert status == VALIDATION_APPROVAL_REQUIRED
    assert "需要用户审批" in err
    assert approval_commands == ["python"]


def test_resolve_work_dir_defaults_to_workspace_root():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)

    try:
        ok, err, resolved = _resolve_work_dir(
            None,
            session_id="session-bash-default",
            workspace_root=str(workspace),
        )
        assert ok is True
        assert err == ""
        assert resolved == workspace.resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_resolve_work_dir_relative_workspace_space_uses_workspace_root():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / "workspace"
    nested = workspace / "nested"
    nested.mkdir(parents=True, exist_ok=True)

    try:
        ok, err, resolved = _resolve_work_dir(
            ".",
            working_dir_space="workspace",
            session_id="session-bash-workspace",
            workspace_root=str(workspace),
        )
        assert ok is True
        assert err == ""
        assert resolved == workspace.resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_resolve_work_dir_relative_transient_space_uses_transient_root():
    session_id = "session-bash-transient"
    target = ROOT_DIR / "data" / "sessions" / session_id / "transient"
    target.mkdir(parents=True, exist_ok=True)

    try:
        ok, err, resolved = _resolve_work_dir(
            ".",
            working_dir_space="transient",
            session_id=session_id,
        )
        assert ok is True
        assert err == ""
        assert resolved == target.resolve()
    finally:
        shutil.rmtree(ROOT_DIR / "data" / "sessions" / session_id, ignore_errors=True)


def test_resolve_work_dir_relative_exports_space_uses_export_run_root():
    session_id = "session-bash-exports"
    run_id = "run-bash-exports"
    target = ROOT_DIR / "data" / "sessions" / session_id / "exports" / run_id
    target.mkdir(parents=True, exist_ok=True)

    try:
        ok, err, resolved = _resolve_work_dir(
            ".",
            working_dir_space="exports",
            session_id=session_id,
            run_id=run_id,
        )
        assert ok is True
        assert err == ""
        assert resolved == target.resolve()
    finally:
        shutil.rmtree(ROOT_DIR / "data" / "sessions" / session_id, ignore_errors=True)


def test_resolve_work_dir_relative_without_space_defaults_to_workspace():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / "workspace"
    logs = workspace / "logs"
    logs.mkdir(parents=True, exist_ok=True)

    try:
        ok, err, resolved = _resolve_work_dir(
            "logs",
            session_id="session-bash-relative-default",
            workspace_root=str(workspace),
        )
        assert ok is True
        assert err == ""
        assert resolved == logs.resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_resolve_work_dir_without_workspace_context_returns_clear_error():
    ok, err, resolved = _resolve_work_dir(None)

    assert ok is False
    assert resolved is None
    assert "缺少可用 workspace 上下文" in err


def test_resolve_work_dir_absolute_out_of_bounds_is_rejected():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / "workspace"
    outside = root / "outside"
    workspace.mkdir(parents=True, exist_ok=True)
    outside.mkdir(parents=True, exist_ok=True)

    try:
        ok, err, resolved = _resolve_work_dir(
            str(outside),
            session_id="session-bash-absolute-boundary",
            workspace_root=str(workspace),
        )
        assert ok is False
        assert resolved is None
        assert "超出允许的受管目录范围" in err
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_execute_bash_pwd_defaults_to_effective_workspace():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})

    try:
        result = execute_bash(
            command="pwd",
            session_id="session-bash-exec-default",
            agent_config=agent_config,
        )
        assert result.success is True
        assert Path(result.metadata["working_dir"]).resolve() == workspace.resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_execute_bash_pwd_uses_workspace_space_when_explicit():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})

    try:
        result = execute_bash(
            command="pwd",
            working_dir=".",
            working_dir_space="workspace",
            session_id="session-bash-exec-workspace",
            agent_config=agent_config,
        )
        assert result.success is True
        assert Path(result.metadata["working_dir"]).resolve() == workspace.resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_execute_bash_pwd_uses_transient_space_when_explicit():
    session_id = "session-bash-exec-transient"
    transient_root = ROOT_DIR / "data" / "sessions" / session_id / "transient"
    transient_root.mkdir(parents=True, exist_ok=True)

    try:
        result = execute_bash(
            command="pwd",
            working_dir=".",
            working_dir_space="transient",
            session_id=session_id,
        )
        assert result.success is True
        assert Path(result.metadata["working_dir"]).resolve() == transient_root.resolve()
    finally:
        shutil.rmtree(ROOT_DIR / "data" / "sessions" / session_id, ignore_errors=True)


def test_execute_bash_pwd_uses_exports_space_when_explicit():
    session_id = "session-bash-exec-exports"
    run_id = "run-bash-exec-exports"
    export_root = ROOT_DIR / "data" / "sessions" / session_id / "exports" / run_id
    export_root.mkdir(parents=True, exist_ok=True)

    try:
        with execution_observability_scope(
            ExecutionObservabilityContext(
                task_id="task-bash-exports",
                execution_kind="test",
                session_id=session_id,
                run_id=run_id,
            )
        ):
            result = execute_bash(
                command="pwd",
                working_dir=".",
                working_dir_space="exports",
                session_id=session_id,
            )
        assert result.success is True
        assert Path(result.metadata["working_dir"]).resolve() == export_root.resolve()
    finally:
        shutil.rmtree(ROOT_DIR / "data" / "sessions" / session_id, ignore_errors=True)


def test_execute_bash_relative_working_dir_without_space_defaults_to_workspace():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / "workspace"
    logs = workspace / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})

    try:
        result = execute_bash(
            command="pwd",
            working_dir="logs",
            session_id="session-bash-exec-relative-default",
            agent_config=agent_config,
        )
        assert result.success is True
        assert Path(result.metadata["working_dir"]).resolve() == logs.resolve()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_execute_bash_without_workspace_context_returns_clear_error():
    result = execute_bash(command="pwd")

    assert result.success is False
    assert "缺少可用 workspace 上下文" in result.summary


def test_execute_bash_workspace_space_creates_default_session_workspace_when_missing():
    session_id = "session-bash-auto-workspace"
    session_root = ROOT_DIR / "data" / "sessions" / session_id
    workspace_root = session_root / "workspace"
    shutil.rmtree(session_root, ignore_errors=True)

    try:
        result = execute_bash(
            command="pwd",
            working_dir=".",
            working_dir_space="workspace",
            session_id=session_id,
        )
        assert result.success is True
        assert workspace_root.exists()
        assert Path(result.metadata["working_dir"]).resolve() == workspace_root.resolve()
    finally:
        shutil.rmtree(session_root, ignore_errors=True)


def test_execute_bash_absolute_working_dir_out_of_bounds_is_rejected():
    root = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    workspace = root / "workspace"
    outside = root / "outside"
    workspace.mkdir(parents=True, exist_ok=True)
    outside.mkdir(parents=True, exist_ok=True)
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})

    try:
        result = execute_bash(
            command="pwd",
            working_dir=str(outside),
            session_id="session-bash-exec-absolute-boundary",
            agent_config=agent_config,
        )
        assert result.success is False
        assert "超出允许的受管目录范围" in result.summary
    finally:
        shutil.rmtree(root, ignore_errors=True)
