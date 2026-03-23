# -*- coding: utf-8 -*-

import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from tools.tool_executor_modules.bash_tool import (
    VALIDATION_ALLOWED,
    VALIDATION_APPROVAL_REQUIRED,
    VALIDATION_BLOCKED,
    _split_shell_pipeline,
    _validate_command,
    execute_bash,
)


class _FakeApprovalRegistry:
    def __init__(self):
        self._events = {}
        self._results = {}

    def add_pending_approval(self, session_id, approval_id):
        event = threading.Event()
        self._events[(session_id, approval_id)] = event
        self._results[(session_id, approval_id)] = (False, "")
        return event

    def resolve_approval(self, session_id, approval_id, approved, message=""):
        key = (session_id, approval_id)
        self._results[key] = (approved, message)
        self._events[key].set()

    def get_approval_result(self, session_id, approval_id):
        return self._results[(session_id, approval_id)]


def _make_workspace() -> Path:
    return Path(tempfile.mkdtemp(prefix="bash-tool-test-"))


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

    status, err, approval_commands = _validate_command(command)

    assert status == VALIDATION_ALLOWED
    assert err == ""
    assert approval_commands == []


def test_validate_command_marks_non_whitelisted_pipeline_command_for_approval():
    status, err, approval_commands = _validate_command('find . -name "*.json" | cp a b')

    assert status == VALIDATION_APPROVAL_REQUIRED
    assert "需要用户审批" in err
    assert approval_commands == ["cp"]


def test_validate_command_marks_dangerous_pipeline_command_for_approval():
    status, err, approval_commands = _validate_command('find . -name "*.json" | python -V')

    assert status == VALIDATION_APPROVAL_REQUIRED
    assert "需要用户审批" in err
    assert approval_commands == ["python"]


def test_execute_bash_allows_whitelisted_command_without_approval():
    workspace = _make_workspace()
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})
    result = execute_bash(command="pwd", working_dir=".", agent_config=agent_config)

    assert result.success is True
    assert result.metadata["working_dir"] == str(workspace)
    assert "approval_required_commands" not in result.metadata


def test_execute_bash_requests_approval_for_non_whitelisted_command(monkeypatch):
    workspace = _make_workspace()
    registry = _FakeApprovalRegistry()
    monkeypatch.setattr("agents.task_registry.get_task_registry", lambda: registry)

    event_bus = MagicMock()
    published = {}
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})

    def fake_publish(event):
        published["event"] = event

        def approve():
            registry.resolve_approval(
                event.session_id,
                event.data["approval_id"],
                True,
                "仅本次放行 cp",
            )

        threading.Thread(target=approve).start()

    event_bus.publish = fake_publish

    source = workspace / "source.txt"
    target = workspace / "target.txt"
    source.write_text("demo", encoding="utf-8")

    result = execute_bash(
        command=f'cp "{source.name}" "{target.name}"',
        working_dir=".",
        agent_config=agent_config,
        event_bus=event_bus,
        session_id="session-bash-allow",
    )

    assert result.success is True
    assert target.read_text(encoding="utf-8") == "demo"
    assert result.metadata["approval_required_commands"] == ["cp"]
    assert result.metadata["approval_message"] == "仅本次放行 cp"
    assert published["event"].data["tool_name"] == "execute_bash"
    assert published["event"].data["approval_type"] == "bash_command"
    assert published["event"].data["command_segments"] == ["cp"]


def test_execute_bash_returns_error_when_non_whitelisted_command_is_denied(monkeypatch):
    workspace = _make_workspace()
    registry = _FakeApprovalRegistry()
    monkeypatch.setattr("agents.task_registry.get_task_registry", lambda: registry)

    event_bus = MagicMock()
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})

    def fake_publish(event):
        def deny():
            registry.resolve_approval(
                event.session_id,
                event.data["approval_id"],
                False,
                "不允许执行复制",
            )

        threading.Thread(target=deny).start()

    event_bus.publish = fake_publish

    source = workspace / "source.txt"
    source.write_text("demo", encoding="utf-8")

    result = execute_bash(
        command=f'cp "{source.name}" "target.txt"',
        working_dir=".",
        agent_config=agent_config,
        event_bus=event_bus,
        session_id="session-bash-deny",
    )

    assert result.success is False
    assert "execute_bash 执行已被拒绝" in result.content
    assert "不允许执行复制" in result.content
    assert result.metadata["approval_required_commands"] == ["cp"]
    assert not (workspace / "target.txt").exists()


def test_execute_bash_marks_dangerous_command_with_stronger_approval_prompt(monkeypatch):
    workspace = _make_workspace()
    registry = _FakeApprovalRegistry()
    monkeypatch.setattr("agents.task_registry.get_task_registry", lambda: registry)

    event_bus = MagicMock()
    published = {}
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})

    def fake_publish(event):
        published["event"] = event

        def approve():
            registry.resolve_approval(event.session_id, event.data["approval_id"], True, "明确知晓风险")

        threading.Thread(target=approve).start()

    event_bus.publish = fake_publish

    result = execute_bash(
        command="rm -rf temp.txt",
        working_dir=".",
        agent_config=agent_config,
        event_bus=event_bus,
        session_id="session-bash-danger",
    )

    assert result.success is True
    assert result.metadata["approval_required_commands"] == ["rm"]
    assert result.metadata["approval_message"] == "明确知晓风险"
    assert published["event"].data["dangerous_command_segments"] == ["rm"]
    assert published["event"].data["risk_level"] == "high"
    assert "高风险命令" in published["event"].data["description"]
    assert "删除文件" in published["event"].data["description"]


def test_execute_bash_requests_approval_when_pipeline_contains_non_whitelisted_command(monkeypatch):
    workspace = _make_workspace()
    registry = _FakeApprovalRegistry()
    monkeypatch.setattr("agents.task_registry.get_task_registry", lambda: registry)

    event_bus = MagicMock()
    published = {}
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})

    def fake_publish(event):
        published["event"] = event

        def approve():
            registry.resolve_approval(event.session_id, event.data["approval_id"], True, "允许 mkdir")

        threading.Thread(target=approve).start()

    event_bus.publish = fake_publish

    result = execute_bash(
        command="pwd | mkdir nested_dir",
        working_dir=".",
        agent_config=agent_config,
        event_bus=event_bus,
        session_id="session-bash-pipeline",
    )

    assert result.success is True
    assert (workspace / "nested_dir").is_dir()
    assert result.metadata["approval_required_commands"] == ["mkdir"]
    assert published["event"].data["command_segments"] == ["mkdir"]
