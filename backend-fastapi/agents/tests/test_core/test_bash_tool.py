# -*- coding: utf-8 -*-

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
    assert published["event"].data["arguments"]["command_segments"] == ["mkdir"]


# ── 命令分类专项测试 ──────────────────────────────────────────


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


# ── 持久化 Shell 测试 ─────────────────────────────────────────

import platform as _platform
import tempfile

import pytest


@pytest.mark.skipif(_platform.system() == "Windows", reason="Windows Git Bash 路径依赖，CI 跳过")
def test_persistent_shell_cwd_persists_across_calls(tmp_path):
    """第二次调用不传 working_dir，验证目录保持第一次 cd 后的位置。"""
    from tools.runtime.persistent_shell import PersistentShellSession

    sub = tmp_path / "subdir"
    sub.mkdir()

    sess = PersistentShellSession()
    try:
        # 第一次：cd 到子目录
        stdout1, stderr1, rc1, _ = sess.execute(
            f"cd '{sub}' && pwd", timeout=10
        )
        assert rc1 == 0
        assert str(sub) in stdout1

        # 第二次：不再 cd，pwd 应仍在 sub（持久 shell 保留了 cwd）
        stdout2, stderr2, rc2, _ = sess.execute("pwd", timeout=10)
        assert rc2 == 0
        # 由于持久 shell cwd 跨调用保留，应仍在 sub
        assert str(sub) in stdout2
    finally:
        sess.close()


@pytest.mark.skipif(_platform.system() == "Windows", reason="Windows Git Bash 路径依赖，CI 跳过")
def test_persistent_shell_env_persists_across_calls():
    """export 设置的环境变量在下一次调用中仍可见。"""
    from tools.runtime.persistent_shell import PersistentShellSession

    sess = PersistentShellSession()
    try:
        _, _, rc1, _ = sess.execute("export _TEST_VAR_PS=hello_world", timeout=10)
        assert rc1 == 0

        stdout2, _, rc2, _ = sess.execute("echo $_TEST_VAR_PS", timeout=10)
        assert rc2 == 0
        assert "hello_world" in stdout2
    finally:
        sess.close()


@pytest.mark.skipif(_platform.system() == "Windows", reason="Windows 信号处理差异，CI 跳过")
def test_persistent_shell_cancel_event_interrupts_command():
    """cancel_event 置位后命令被中断，interrupted=True。"""
    from tools.runtime.persistent_shell import PersistentShellSession

    sess = PersistentShellSession()
    cancel_ev = threading.Event()

    def _cancel_after():
        import time
        time.sleep(0.3)
        cancel_ev.set()

    t = threading.Thread(target=_cancel_after, daemon=True)
    t.start()

    try:
        _, _, _, interrupted = sess.execute(
            "sleep 30", timeout=60, cancel_event=cancel_ev
        )
        assert interrupted is True
    finally:
        sess.close()


def test_persistent_shell_manager_get_session_returns_same_instance():
    """同一 session_id 返回同一 shell 实例。"""
    from tools.runtime.persistent_shell import PersistentShellManager

    mgr = PersistentShellManager()
    sid = "test-session-mgr-" + uuid.uuid4().hex[:8]

    import sys
    # 避免 CI Windows 无 bash 时直接报错
    try:
        s1 = mgr.get_session(sid)
        s2 = mgr.get_session(sid)
        assert s1 is s2
    except Exception:
        pytest.skip("bash 不可用，跳过")
    finally:
        mgr.close_session(sid)


def test_persistent_shell_session_end_closes_shell():
    """SESSION_END 事件触发后 session 被清理。"""
    from tools.runtime.persistent_shell import PersistentShellManager

    class FakeBus:
        def __init__(self):
            self._handlers = []

        def subscribe(self, event_types, handler, **_):
            self._handlers.append(handler)

        def fire_session_end(self, session_id):
            class _Ev:
                pass
            ev = _Ev()
            ev.session_id = session_id
            ev.data = {}
            for h in self._handlers:
                h(ev)

    bus = FakeBus()
    mgr = PersistentShellManager()
    sid = "test-session-end-" + uuid.uuid4().hex[:8]

    try:
        sess = mgr.get_session(sid, event_bus=bus)
        bus.fire_session_end(sid)
        # session 已被清理
        with mgr._lock:
            assert sid not in mgr._sessions
    except Exception:
        pytest.skip("bash 不可用，跳过")
    finally:
        mgr.close_session(sid)


import uuid
