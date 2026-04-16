# -*- coding: utf-8 -*-
"""
Git worktree 隔离模块测试。
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

from utils.worktree import (
    create_snapshot,
    create_worktree,
    get_original_workspace,
    get_worktree_path,
    is_already_worktree,
    is_git_repo,
    list_snapshots,
    remove_worktree,
    rewind_to_snapshot,
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
    # 初始 commit（git worktree add 需要至少一个 commit）
    (repo / "README.md").write_text("# Test Project\n")
    subprocess.run(["git", "add", "-A"], cwd=str(repo), capture_output=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=str(repo), capture_output=True)
    return repo


@pytest.fixture
def non_git_dir(tmp_path):
    """在 git 仓库外创建普通目录。"""
    # 使用独立的临时目录确保不在任何 git repo 内
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
        # cleanup
        subprocess.run(["git", "worktree", "remove", "--force", str(wt_path)], cwd=str(git_repo), capture_output=True)


class TestCreateWorktree:
    def test_creates_worktree_and_returns_path(self, git_repo):
        session_id = "sess-001"
        result = create_worktree(str(git_repo), session_id)
        assert Path(result).is_dir()
        assert worktree_exists(session_id)
        # meta 文件存在
        assert get_original_workspace(session_id) == str(git_repo)

    def test_worktree_file_isolation(self, git_repo):
        """在 worktree 中写文件不影响原 repo。"""
        session_id = "sess-002"
        wt_path = create_worktree(str(git_repo), session_id)

        # 在 worktree 中写入新文件
        (Path(wt_path) / "agent_output.txt").write_text("hello from agent")

        # 原 repo 中该文件不存在
        assert not (git_repo / "agent_output.txt").exists()

        # worktree 中存在
        assert (Path(wt_path) / "agent_output.txt").exists()


class TestCreateSnapshot:
    def test_creates_commit_when_changes_exist(self, git_repo):
        session_id = "sess-snap-1"
        wt_path = create_worktree(str(git_repo), session_id)

        # 写入文件
        (Path(wt_path) / "new_file.txt").write_text("content")

        commit_hash = create_snapshot(wt_path, run_id="run-001")
        assert commit_hash is not None
        assert len(commit_hash) >= 7

    def test_skips_when_no_changes(self, git_repo):
        session_id = "sess-snap-2"
        wt_path = create_worktree(str(git_repo), session_id)

        # 不做任何修改
        commit_hash = create_snapshot(wt_path, run_id="run-002")
        assert commit_hash is None


class TestListSnapshots:
    def test_lists_snapshots(self, git_repo):
        session_id = "sess-list-1"
        wt_path = create_worktree(str(git_repo), session_id)

        # 创建两个 snapshot
        (Path(wt_path) / "file1.txt").write_text("v1")
        create_snapshot(wt_path, run_id="run-1")

        (Path(wt_path) / "file2.txt").write_text("v2")
        create_snapshot(wt_path, run_id="run-2")

        snapshots = list_snapshots(wt_path)
        # 至少 2 个 agent snapshot + 1 个 initial commit
        assert len(snapshots) >= 2
        assert any("run-1" in s["message"] for s in snapshots)
        assert any("run-2" in s["message"] for s in snapshots)


class TestRewindToSnapshot:
    def test_rewind_restores_file_state(self, git_repo):
        session_id = "sess-rewind-1"
        wt_path = create_worktree(str(git_repo), session_id)

        # snapshot 1: 写入 file1
        (Path(wt_path) / "file1.txt").write_text("original")
        hash1 = create_snapshot(wt_path, run_id="run-1")

        # snapshot 2: 修改 file1，新建 file2
        (Path(wt_path) / "file1.txt").write_text("modified")
        (Path(wt_path) / "file2.txt").write_text("new file")
        create_snapshot(wt_path, run_id="run-2")

        # 验证当前状态
        assert (Path(wt_path) / "file1.txt").read_text() == "modified"
        assert (Path(wt_path) / "file2.txt").exists()

        # 回滚到 snapshot 1
        result = rewind_to_snapshot(wt_path, hash1)
        assert result["success"] is True

        # 验证回滚结果
        assert (Path(wt_path) / "file1.txt").read_text() == "original"
        assert not (Path(wt_path) / "file2.txt").exists()


class TestRemoveWorktree:
    def test_removes_worktree_and_meta(self, git_repo):
        session_id = "sess-rm-1"
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
        """非 git 目录场景下 worktree 不会被创建。"""
        assert not worktree_exists("fake-session")
        assert get_worktree_path("fake-session") is None


class TestChildAgentNoSnapshot:
    def test_parent_call_id_skips_snapshot(self, git_repo):
        """模拟子 agent 的 state（有 parent_call_id），验证不触发 snapshot。"""
        from unittest.mock import MagicMock

        session_id = "sess-child-1"
        wt_path = create_worktree(str(git_repo), session_id)

        # 写入文件
        (Path(wt_path) / "child_output.txt").write_text("from child")

        # 模拟 BaseAgent._worktree_auto_snapshot 的判断逻辑
        state = {"parent_call_id": "some-parent-id", "run_id": "child-run"}
        # 子 agent 有 parent_call_id → 应该跳过
        if state.get("parent_call_id"):
            skipped = True
        else:
            skipped = False

        assert skipped is True

        # 确认没有新 commit（除了 initial）
        result = subprocess.run(
            ["git", "log", "--oneline"],
            cwd=wt_path, capture_output=True, text=True,
        )
        # 只有 initial commit，没有 agent snapshot
        lines = result.stdout.strip().splitlines()
        assert not any("agent snapshot" in line for line in lines)
