# -*- coding: utf-8 -*-
"""
Git worktree 隔离模块测试。

Snapshot 相关测试已迁移到 test_file_history.py。
"""

import subprocess
from pathlib import Path

import pytest

from utils.worktree import (
    create_worktree,
    get_original_workspace,
    get_worktree_path,
    is_already_worktree,
    is_git_repo,
    remove_worktree,
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
    import tempfile
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
#  Worktree 层
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
