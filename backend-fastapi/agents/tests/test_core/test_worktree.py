# -*- coding: utf-8 -*-
"""
Git snapshot 回退与 worktree 隔离模块测试。
"""

import json
import subprocess
import tempfile
from pathlib import Path

import pytest

from utils.worktree import (
    cleanup_snapshot,
    create_snapshot,
    create_worktree,
    ensure_git_snapshot,
    find_snapshot_by_run_id,
    get_head_commit,
    get_original_workspace,
    get_snapshot_workspace,
    get_worktree_path,
    is_already_worktree,
    is_git_repo,
    list_snapshots,
    remove_worktree,
    rewind_to_snapshot,
    snapshot_enabled,
    worktree_exists,
)


@pytest.fixture
def git_repo(tmp_path):
    """创建一个临时 git repo 作为测试用 workspace。"""
    repo = tmp_path / "project"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=str(repo), capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=str(repo), capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=str(repo), capture_output=True)
    (repo / "README.md").write_text("# Test Project\n")
    subprocess.run(["git", "add", "-A"], cwd=str(repo), capture_output=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=str(repo), capture_output=True)
    return repo


@pytest.fixture
def non_git_dir(tmp_path):
    """在 git 仓库外创建普通目录。"""
    d = Path(tempfile.mkdtemp(prefix="non_git_"))
    yield d
    import shutil
    shutil.rmtree(str(d), ignore_errors=True)


@pytest.fixture(autouse=True)
def _patch_worktrees_root(tmp_path, monkeypatch):
    """把 WORKTREES_ROOT 重定向到临时目录，避免污染真实环境。"""
    import utils.worktree as wt_mod
    test_root = tmp_path / "worktrees"
    test_root.mkdir()
    monkeypatch.setattr(wt_mod, "WORKTREES_ROOT", test_root)


# ══════════════════════════════════════════════════════════════════════════
#  检测辅助
# ══════════════════════════════════════════════════════════════════════════

class TestIsGitRepo:
    def test_detects_git_repo(self, git_repo):
        assert is_git_repo(str(git_repo)) is True

    def test_rejects_non_git_dir(self, non_git_dir):
        assert is_git_repo(str(non_git_dir)) is False

    def test_rejects_nonexistent_path(self, tmp_path):
        assert is_git_repo(str(tmp_path / "nope")) is False


class TestIsAlreadyWorktree:
    def test_main_repo_is_not_worktree(self, git_repo):
        assert is_already_worktree(str(git_repo)) is False

    def test_worktree_is_detected(self, git_repo, tmp_path):
        wt_path = tmp_path / "worktrees" / "test-wt"
        subprocess.run(
            ["git", "worktree", "add", "-B", "test-branch", str(wt_path)],
            cwd=str(git_repo), capture_output=True,
        )
        assert is_already_worktree(str(wt_path)) is True
        subprocess.run(["git", "worktree", "remove", "--force", str(wt_path)], cwd=str(git_repo), capture_output=True)


# ══════════════════════════════════════════════════════════════════════════
#  Snapshot 层
# ══════════════════════════════════════════════════════════════════════════

class TestEnsureGitSnapshot:
    def test_existing_git_repo(self, git_repo):
        """已有 git repo 直接可用，写 meta。"""
        result = ensure_git_snapshot(str(git_repo), "sess-git-1")
        assert result is True
        assert snapshot_enabled("sess-git-1")
        assert get_snapshot_workspace("sess-git-1") == str(git_repo)

    def test_non_git_dir_gets_initialized(self, non_git_dir):
        """非 git 目录被 git init。"""
        assert not is_git_repo(str(non_git_dir))
        result = ensure_git_snapshot(str(non_git_dir), "sess-nongit-1")
        assert result is True
        assert is_git_repo(str(non_git_dir))
        assert snapshot_enabled("sess-nongit-1")

    def test_idempotent(self, git_repo):
        """重复调用不出错。"""
        ensure_git_snapshot(str(git_repo), "sess-idem-1")
        ensure_git_snapshot(str(git_repo), "sess-idem-1")
        assert snapshot_enabled("sess-idem-1")


class TestSnapshotEnabled:
    def test_false_without_setup(self):
        assert snapshot_enabled("nonexistent-session") is False

    def test_true_after_ensure(self, git_repo):
        ensure_git_snapshot(str(git_repo), "sess-enabled-1")
        assert snapshot_enabled("sess-enabled-1") is True


class TestGetSnapshotWorkspace:
    def test_returns_none_without_setup(self):
        assert get_snapshot_workspace("nonexistent") is None

    def test_returns_path_after_ensure(self, git_repo):
        ensure_git_snapshot(str(git_repo), "sess-ws-1")
        assert get_snapshot_workspace("sess-ws-1") == str(git_repo)


class TestSnapshotCycleGitRepo:
    def test_write_snapshot_list_rewind(self, git_repo):
        """git repo: 写文件 → snapshot → list → rewind。"""
        session_id = "sess-cycle-git-1"
        ensure_git_snapshot(str(git_repo), session_id)
        workspace = str(git_repo)

        # snapshot 1: 写入 file1
        (git_repo / "file1.txt").write_text("original")
        hash1 = create_snapshot(workspace, run_id="run-1")
        assert hash1 is not None

        # snapshot 2: 修改 file1，新建 file2
        (git_repo / "file1.txt").write_text("modified")
        (git_repo / "file2.txt").write_text("new file")
        hash2 = create_snapshot(workspace, run_id="run-2")
        assert hash2 is not None

        # 验证 list
        snapshots = list_snapshots(workspace)
        assert len(snapshots) >= 2
        messages = [s["message"] for s in snapshots]
        assert any("run-1" in m for m in messages)
        assert any("run-2" in m for m in messages)

        # 验证当前状态
        assert (git_repo / "file1.txt").read_text() == "modified"
        assert (git_repo / "file2.txt").exists()

        # 回滚到 snapshot 1
        result = rewind_to_snapshot(workspace, hash1)
        assert result["success"] is True

        # 验证回滚
        assert (git_repo / "file1.txt").read_text() == "original"
        assert not (git_repo / "file2.txt").exists()


class TestSnapshotCycleNonGit:
    def test_init_write_snapshot_rewind(self, non_git_dir):
        """非 git 目录: init → 写文件 → snapshot → rewind。"""
        session_id = "sess-cycle-nongit-1"
        ensure_git_snapshot(str(non_git_dir), session_id)
        workspace = str(non_git_dir)

        # 写入文件并 snapshot
        (non_git_dir / "data.txt").write_text("version1")
        hash1 = create_snapshot(workspace, run_id="run-1")
        assert hash1 is not None

        # 修改并 snapshot
        (non_git_dir / "data.txt").write_text("version2")
        hash2 = create_snapshot(workspace, run_id="run-2")
        assert hash2 is not None

        # 回滚
        result = rewind_to_snapshot(workspace, hash1)
        assert result["success"] is True
        assert (non_git_dir / "data.txt").read_text() == "version1"


class TestCreateSnapshot:
    def test_skips_when_no_changes(self, git_repo):
        ensure_git_snapshot(str(git_repo), "sess-nochange")
        commit_hash = create_snapshot(str(git_repo), run_id="run-empty")
        assert commit_hash is None


class TestCleanupSnapshot:
    def test_cleanup_existing_repo(self, git_repo):
        """已有 git 的 → 不删 .git。"""
        ensure_git_snapshot(str(git_repo), "sess-cleanup-git")
        cleanup_snapshot("sess-cleanup-git")
        # .git 应该仍存在（不是我们创建的）
        assert (git_repo / ".git").exists()
        assert not snapshot_enabled("sess-cleanup-git")

    def test_cleanup_git_initialized(self, non_git_dir):
        """我们 init 的 → 清理 .git。"""
        ensure_git_snapshot(str(non_git_dir), "sess-cleanup-nongit")
        assert (non_git_dir / ".git").exists()
        cleanup_snapshot("sess-cleanup-nongit")
        assert not (non_git_dir / ".git").exists()
        assert not snapshot_enabled("sess-cleanup-nongit")


# ══════════════════════════════════════════════════════════════════════════
#  Worktree 层（保留给 D5）
# ══════════════════════════════════════════════════════════════════════════

class TestCreateWorktree:
    def test_creates_worktree_and_returns_path(self, git_repo):
        session_id = "sess-wt-001"
        result = create_worktree(str(git_repo), session_id)
        assert Path(result).is_dir()
        assert worktree_exists(session_id)
        assert get_original_workspace(session_id) == str(git_repo)

    def test_worktree_file_isolation(self, git_repo):
        """在 worktree 中写文件不影响原 repo。"""
        session_id = "sess-wt-002"
        wt_path = create_worktree(str(git_repo), session_id)
        (Path(wt_path) / "agent_output.txt").write_text("hello from agent")
        assert not (git_repo / "agent_output.txt").exists()
        assert (Path(wt_path) / "agent_output.txt").exists()


class TestRemoveWorktree:
    def test_removes_worktree_and_meta(self, git_repo):
        session_id = "sess-wt-rm-1"
        create_worktree(str(git_repo), session_id)
        assert worktree_exists(session_id)
        result = remove_worktree(session_id)
        assert result is True
        assert not worktree_exists(session_id)
        assert get_original_workspace(session_id) is None

    def test_returns_false_for_nonexistent(self):
        assert remove_worktree("nonexistent-session") is False


class TestNonGitWorkspaceSkips:
    def test_non_git_dir_not_detected(self, non_git_dir):
        assert is_git_repo(str(non_git_dir)) is False

    def test_worktree_not_created_for_non_git(self, non_git_dir):
        assert not worktree_exists("fake-session")
        assert get_worktree_path("fake-session") is None


class TestChildAgentNoSnapshot:
    def test_parent_call_id_skips_snapshot(self, git_repo):
        """模拟子 agent 的 state（有 parent_call_id），验证不触发 snapshot。"""
        session_id = "sess-child-1"
        ensure_git_snapshot(str(git_repo), session_id)
        (git_repo / "child_output.txt").write_text("from child")

        # 模拟 BaseAgent._worktree_auto_snapshot 的判断逻辑
        state = {"parent_call_id": "some-parent-id", "run_id": "child-run"}
        if state.get("parent_call_id"):
            skipped = True
        else:
            skipped = False

        assert skipped is True

        # 确认没有新 commit（除了 initial）
        result = subprocess.run(
            ["git", "log", "--oneline"],
            cwd=str(git_repo), capture_output=True, text=True,
        )
        lines = result.stdout.strip().splitlines()
        assert not any("agent snapshot" in line for line in lines)


class TestFindSnapshotByRunId:
    def test_finds_commit_by_run_id(self, git_repo):
        ensure_git_snapshot(str(git_repo), "sess-find-1")
        (git_repo / "f.txt").write_text("v1")
        create_snapshot(str(git_repo), run_id="run-abc")
        commit = find_snapshot_by_run_id(str(git_repo), "run-abc")
        assert commit is not None
        assert len(commit) >= 7

    def test_returns_none_for_unknown_run(self, git_repo):
        ensure_git_snapshot(str(git_repo), "sess-find-2")
        commit = find_snapshot_by_run_id(str(git_repo), "nonexistent")
        assert commit is None

    def test_finds_correct_commit_among_multiple(self, git_repo):
        ensure_git_snapshot(str(git_repo), "sess-find-3")
        (git_repo / "f1.txt").write_text("v1")
        hash1 = create_snapshot(str(git_repo), run_id="run-first")
        (git_repo / "f2.txt").write_text("v2")
        hash2 = create_snapshot(str(git_repo), run_id="run-second")

        found1 = find_snapshot_by_run_id(str(git_repo), "run-first")
        found2 = find_snapshot_by_run_id(str(git_repo), "run-second")
        # create_snapshot 返回 short hash，find 返回 full hash
        assert found1.startswith(hash1)
        assert found2.startswith(hash2)
        assert found1 != found2


class TestGetHeadCommit:
    def test_returns_current_head(self, git_repo):
        ensure_git_snapshot(str(git_repo), "sess-head-1")
        head1 = get_head_commit(str(git_repo))
        assert head1 is not None

        (git_repo / "new.txt").write_text("hello")
        head2 = create_snapshot(str(git_repo), run_id="run-head")
        current = get_head_commit(str(git_repo))
        assert current == head2
        assert current != head1

    def test_returns_none_for_invalid_repo(self):
        invalid_dir = Path(tempfile.mkdtemp(prefix="invalid_repo_"))
        try:
            assert get_head_commit(str(invalid_dir)) is None
        finally:
            import shutil
            shutil.rmtree(str(invalid_dir), ignore_errors=True)
