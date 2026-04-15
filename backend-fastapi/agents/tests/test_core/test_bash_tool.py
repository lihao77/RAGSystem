# -*- coding: utf-8 -*-

import shutil
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from tools.local.bash_tool import (
    VALIDATION_ALLOWED,
    VALIDATION_APPROVAL_REQUIRED,
    VALIDATION_BLOCKED,
    _split_shell_pipeline,
    _validate_command,
    execute_bash,
)
from tools.runtime.background_tasks import get_background_task_manager
from tools.runtime.bash_security import (
    classify_command,
    classify_command_name,
    classify_pipeline,
    CommandCategory,
    _split_shell_chain,
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

    status, err, approval_commands, classification = _validate_command(command)

    assert status == VALIDATION_ALLOWED
    assert err == ""
    assert approval_commands == []


def test_validate_command_allows_read_only_sed_without_approval():
    status, err, approval_commands, _ = _validate_command("sed -n '1,3p' demo.txt")

    assert status == VALIDATION_ALLOWED
    assert err == ""
    assert approval_commands == []


def test_validate_command_marks_sed_inplace_for_approval():
    status, err, approval_commands, _ = _validate_command("sed -i 's/a/b/' demo.txt")

    assert status == VALIDATION_APPROVAL_REQUIRED
    assert "需要用户审批" in err
    assert approval_commands == ["sed"]


def test_validate_command_does_not_block_find_escaped_parentheses():
    status, err, approval_commands, _ = _validate_command(r"find . -name '*.txt' \( -type f \)")

    assert status == VALIDATION_ALLOWED
    assert err == ""
    assert approval_commands == []


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
    assert published["event"].data["arguments"]["command_segments"] == ["cp"]


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
    assert published["event"].data["arguments"]["dangerous_command_segments"] == ["rm"]
    assert published["event"].data["risk_level"] == "high"
    assert "高风险命令" in published["event"].data["description"]
    assert "删除文件" in published["event"].data["description"]


def test_execute_bash_background_returns_task_info_without_wait_hint(monkeypatch):
    workspace = _make_workspace()
    transient_root = workspace / "transient"
    transient_root.mkdir()
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})
    bg_manager = get_background_task_manager()
    bg_manager._tasks.clear()
    bg_manager._processes.clear()

    monkeypatch.setattr(
        "tools.local.bash_tool.get_current_execution_observability_fields",
        lambda: {"run_id": "run-1", "task_id": "task-1"},
    )
    monkeypatch.setattr(
        "tools.local.bash_tool.get_session_transient_root",
        lambda session_id: transient_root,
    )

    result = execute_bash(
        command="pwd",
        working_dir=".",
        agent_config=agent_config,
        session_id="session-bash-bg",
        run_in_background=True,
    )

    assert result.success is True
    assert result.content["background_started"] is True
    assert "suggest_wait" not in result.content
    assert result.metadata["background_kind"] == "bash"
    assert result.metadata["cancel_supported"] is True
    assert result.content["background_task_id"]


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
    assert published["event"].data["arguments"]["command_segments"] == ["mkdir"]


def test_execute_bash_allows_external_working_dir_when_approved(monkeypatch):
    workspace = _make_workspace()
    outside = Path(tempfile.mkdtemp(prefix="bash-tool-outside-"))
    registry = _FakeApprovalRegistry()
    monkeypatch.setattr("agents.task_registry.get_task_registry", lambda: registry)

    event_bus = MagicMock()
    published = {}
    agent_config = SimpleNamespace(custom_params={"workspace_root": str(workspace)})

    def fake_publish(event):
        published["event"] = event

        def approve():
            registry.resolve_approval(event.session_id, event.data["approval_id"], True, "允许外部目录")

        threading.Thread(target=approve).start()

    event_bus.publish = fake_publish

    try:
        result = execute_bash(
            command="pwd",
            working_dir=str(outside),
            agent_config=agent_config,
            event_bus=event_bus,
            session_id="session-bash-external-dir",
            approved_external_paths=[str(outside)],
        )
        assert result.success is True
        assert Path(result.metadata["working_dir"]).resolve() == outside.resolve()
    finally:
        shutil.rmtree(outside, ignore_errors=True)




def test_classify_tar_list_is_read_only():
    assert classify_command("tar", ["tar", "-tf", "archive.tar"]) == CommandCategory.READ_ONLY
    assert classify_command("tar", ["tar", "-tvf", "archive.tar"]) == CommandCategory.READ_ONLY
    assert classify_command("tar", ["tar", "--list", "-f", "archive.tar"]) == CommandCategory.READ_ONLY


def test_classify_tar_extract_is_write():
    assert classify_command("tar", ["tar", "-xf", "archive.tar"]) == CommandCategory.WRITE
    assert classify_command("tar", ["tar", "-xvf", "archive.tar"]) == CommandCategory.WRITE
    assert classify_command("tar", ["tar", "-cf", "archive.tar", "dir/"]) == CommandCategory.WRITE


def test_classify_tar_no_args_is_write():
    # 无参数上下文时按最坏情况（写）
    assert classify_command_name("tar") == CommandCategory.WRITE


def test_classify_unzip_list_is_read_only():
    assert classify_command("unzip", ["unzip", "-l", "archive.zip"]) == CommandCategory.READ_ONLY
    assert classify_command("unzip", ["unzip", "-v", "archive.zip"]) == CommandCategory.READ_ONLY


def test_classify_unzip_extract_is_write():
    assert classify_command("unzip", ["unzip", "archive.zip"]) == CommandCategory.WRITE
    assert classify_command_name("unzip") == CommandCategory.WRITE


def test_classify_zip_list_is_read_only():
    assert classify_command("zip", ["zip", "-l", "archive.zip"]) == CommandCategory.READ_ONLY


def test_classify_zip_create_is_write():
    assert classify_command("zip", ["zip", "archive.zip", "file.txt"]) == CommandCategory.WRITE
    assert classify_command_name("zip") == CommandCategory.WRITE


def test_classify_gzip_test_is_read_only():
    assert classify_command("gzip", ["gzip", "-t", "file.gz"]) == CommandCategory.READ_ONLY
    assert classify_command("gzip", ["gzip", "-l", "file.gz"]) == CommandCategory.READ_ONLY


def test_classify_gzip_compress_is_write():
    assert classify_command("gzip", ["gzip", "file.txt"]) == CommandCategory.WRITE
    assert classify_command_name("gunzip") == CommandCategory.WRITE


def test_classify_sed_inplace_with_backup_is_write():
    # sed -i.bak 也应被识别为写操作
    assert classify_command("sed", ["sed", "-i.bak", "s/a/b/", "file.txt"]) == CommandCategory.WRITE
    assert classify_command("sed", ["sed", "-i''", "s/a/b/", "file.txt"]) == CommandCategory.WRITE


def test_validate_command_marks_tar_extract_for_approval():
    status, err, approval_commands, classification = _validate_command("tar -xvf archive.tar")
    assert status == VALIDATION_APPROVAL_REQUIRED
    assert approval_commands == ["tar"]
    assert classification == CommandCategory.WRITE


def test_validate_command_allows_tar_list():
    status, err, approval_commands, classification = _validate_command("tar -tf archive.tar")
    assert status == VALIDATION_ALLOWED
    assert approval_commands == []
    assert classification == CommandCategory.READ_ONLY


def test_validate_command_marks_unzip_extract_for_approval():
    status, err, approval_commands, _ = _validate_command("unzip archive.zip")
    assert status == VALIDATION_APPROVAL_REQUIRED
    assert approval_commands == ["unzip"]


def test_validate_command_allows_unzip_list():
    status, err, approval_commands, _ = _validate_command("unzip -l archive.zip")
    assert status == VALIDATION_ALLOWED
    assert approval_commands == []


# ── 链式命令分段测试 ──────────────────────────────────────────

def test_split_shell_chain_semicolon():
    segs = _split_shell_chain("echo hello; ls")
    assert len(segs) == 2
    assert segs[0].strip() == "echo hello"
    assert segs[1].strip() == "ls"


def test_split_shell_chain_and_operator():
    segs = _split_shell_chain("mkdir foo && cd foo")
    assert len(segs) == 2
    assert segs[0].strip() == "mkdir foo"
    assert segs[1].strip() == "cd foo"


def test_split_shell_chain_or_operator():
    segs = _split_shell_chain("ls foo || echo missing")
    assert len(segs) == 2
    assert segs[0].strip() == "ls foo"
    assert segs[1].strip() == "echo missing"


def test_split_shell_chain_ignores_operators_in_quotes():
    segs = _split_shell_chain("echo 'a && b; c'")
    assert len(segs) == 1
    assert segs[0].strip() == "echo 'a && b; c'"


def test_split_shell_chain_with_pipeline():
    # "ls | grep foo && echo done" → ["ls ", " grep foo", " echo done"]
    segs = _split_shell_chain("ls | grep foo && echo done")
    assert len(segs) == 3


def test_validate_command_allows_shell_chain_with_safe_commands():
    # && 不再被规则 12 拦截，两段都是只读命令 → ALLOWED
    status, err, approval_commands, classification = _validate_command("echo hello && ls")
    assert status == VALIDATION_ALLOWED
    assert err == ""
    assert approval_commands == []


def test_validate_command_chain_with_write_requires_approval():
    # && 链中含写操作命令 → APPROVAL_REQUIRED
    status, err, approval_commands, classification = _validate_command("ls && mkdir newdir")
    assert status == VALIDATION_APPROVAL_REQUIRED
    assert "mkdir" in approval_commands


def test_classify_pipeline_chain_takes_highest_risk():
    # "echo hi; rm -rf /tmp/x" → DESTRUCTIVE
    cat = classify_pipeline("echo hi; rm -rf /tmp/x")
    assert cat == CommandCategory.DESTRUCTIVE


