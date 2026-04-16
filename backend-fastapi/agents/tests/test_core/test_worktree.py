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
    d = tmp_path / "non-git"
    d.mkdir()
    return d


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
        wt_path = tmp_path / "test-wt"
        subprocess.run(
            ["git", "worktree", "add", "-B", "test-branch", str(wt_path)],
            cwd=str(git_repo), capture_output=True,
        )
        assert is_already_worktree(str(wt_path)) is True
        subprocess.run(["git", "worktree", "remove", "--force", str(wt_path)], cwd=str(git_repo), capture_output=True)


class TestCreateWorktree:
    def test_creates_repo_local_worktree_and_returns_path(self, git_repo):
        child_agent_id = "child-wt-001"
        result = create_worktree(str(git_repo), child_agent_id)
        expected = git_repo / ".ragsystem" / "worktrees" / child_agent_id
        assert Path(result) == expected
        assert expected.is_dir()
        assert worktree_exists(str(git_repo), child_agent_id)
        assert get_worktree_path(str(git_repo), child_agent_id) == str(expected)
        assert get_original_workspace(str(git_repo), child_agent_id) == str(git_repo.resolve())

    def test_worktree_file_isolation(self, git_repo):
        child_agent_id = "child-wt-002"
        wt_path = create_worktree(str(git_repo), child_agent_id)
        (Path(wt_path) / "agent_output.txt").write_text("hello from agent")
        assert not (git_repo / "agent_output.txt").exists()
        assert (Path(wt_path) / "agent_output.txt").exists()

    def test_reuses_existing_worktree(self, git_repo):
        child_agent_id = "child-wt-003"
        first = create_worktree(str(git_repo), child_agent_id)
        second = create_worktree(str(git_repo), child_agent_id)
        assert first == second


class TestRemoveWorktree:
    def test_removes_worktree_and_meta(self, git_repo):
        child_agent_id = "child-wt-rm-1"
        create_worktree(str(git_repo), child_agent_id)
        assert worktree_exists(str(git_repo), child_agent_id)
        result = remove_worktree(str(git_repo), child_agent_id)
        assert result is True
        assert not worktree_exists(str(git_repo), child_agent_id)
        assert get_original_workspace(str(git_repo), child_agent_id) is None

    def test_returns_false_for_nonexistent(self, git_repo):
        assert remove_worktree(str(git_repo), "nonexistent-child") is False


class TestNonGitWorkspaceSkips:
    def test_non_git_dir_not_detected(self, non_git_dir):
        assert is_git_repo(str(non_git_dir)) is False

    def test_worktree_not_created_for_non_git(self, non_git_dir):
        assert not worktree_exists(str(non_git_dir), "fake-child")
        assert get_worktree_path(str(non_git_dir), "fake-child") is None
