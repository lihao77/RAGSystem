# -*- coding: utf-8 -*-
"""FileHistoryService 单元测试。"""

import json
from pathlib import Path

import pytest

from services.file_history import FileHistoryService, get_file_history, remove_file_history, _instances


@pytest.fixture(autouse=True)
def _isolate_file_history(tmp_path, monkeypatch):
    """把 FILE_HISTORY_ROOT 重定向到临时目录，并清空实例缓存。"""
    import services.file_history as mod
    monkeypatch.setattr(mod, "FILE_HISTORY_ROOT", tmp_path / "file-history")
    _instances.clear()
    yield
    _instances.clear()


@pytest.fixture
def workspace(tmp_path):
    """创建一个模拟 workspace。"""
    ws = tmp_path / "workspace"
    ws.mkdir()
    return ws


# ══════════════════════════════════════════════════════════════════════════
#  track_edit 基础
# ══════════════════════════════════════════════════════════════════════════

class TestTrackEdit:
    def test_track_existing_file_as_modified(self, workspace):
        fh = FileHistoryService("sess-1")
        f = workspace / "hello.txt"
        f.write_text("original content")

        fh.track_edit(str(f))
        assert str(f.resolve()) in fh._tracked
        info = fh._tracked[str(f.resolve())]
        assert info["action"] == "modified"
        assert info["backup_hash"] is not None

    def test_track_nonexistent_file_as_created(self, workspace):
        fh = FileHistoryService("sess-2")
        f = workspace / "new_file.txt"
        assert not f.exists()

        fh.track_edit(str(f))
        info = fh._tracked[str(f.resolve())]
        assert info["action"] == "created"
        assert info["backup_hash"] is None

    def test_track_same_file_twice_keeps_first(self, workspace):
        fh = FileHistoryService("sess-3")
        f = workspace / "data.txt"
        f.write_text("v1")

        fh.track_edit(str(f))
        first_hash = fh._tracked[str(f.resolve())]["backup_hash"]

        # 修改文件后再追踪，不应覆盖
        f.write_text("v2")
        fh.track_edit(str(f))
        assert fh._tracked[str(f.resolve())]["backup_hash"] == first_hash

    def test_backup_content_dedup(self, workspace):
        fh = FileHistoryService("sess-4")
        f1 = workspace / "a.txt"
        f2 = workspace / "b.txt"
        f1.write_text("same content")
        f2.write_text("same content")

        fh.track_edit(str(f1))
        fh.track_edit(str(f2))

        h1 = fh._tracked[str(f1.resolve())]["backup_hash"]
        h2 = fh._tracked[str(f2.resolve())]["backup_hash"]
        assert h1 == h2  # 相同内容只存一份


# ══════════════════════════════════════════════════════════════════════════
#  make_snapshot
# ══════════════════════════════════════════════════════════════════════════

class TestMakeSnapshot:
    def test_returns_none_when_no_tracked_files(self):
        fh = FileHistoryService("sess-snap-1")
        assert fh.make_snapshot(1) is None

    def test_creates_snapshot_and_clears_tracked(self, workspace):
        fh = FileHistoryService("sess-snap-2")
        f = workspace / "file.txt"
        f.write_text("hello")
        fh.track_edit(str(f))

        sid = fh.make_snapshot(10)
        assert sid is not None
        assert len(sid) == 16
        assert fh._tracked == {}  # 已清空

    def test_snapshot_persisted_to_disk(self, workspace):
        fh = FileHistoryService("sess-snap-3")
        f = workspace / "file.txt"
        f.write_text("hello")
        fh.track_edit(str(f))
        fh.make_snapshot(5)

        snapshots = fh._load_snapshots()
        assert len(snapshots) == 1
        assert snapshots[0]["message_seq"] == 5
        assert len(snapshots[0]["tracked_files"]) == 1

    def test_multiple_snapshots_accumulate(self, workspace):
        fh = FileHistoryService("sess-snap-4")

        f = workspace / "file.txt"
        f.write_text("v1")
        fh.track_edit(str(f))
        fh.make_snapshot(1)

        f.write_text("v2")
        fh.track_edit(str(f))
        fh.make_snapshot(2)

        assert len(fh._load_snapshots()) == 2


# ══════════════════════════════════════════════════════════════════════════
#  rewind
# ══════════════════════════════════════════════════════════════════════════

class TestRewind:
    def test_rewind_modified_file(self, workspace):
        """track_edit 在写入前调用 → rewind 恢复到目标快照时的文件状态。"""
        fh = FileHistoryService("sess-rw-1")
        f = workspace / "data.txt"
        f.write_text("original")

        # Round 1: agent 编辑文件（track_edit 在写入前）
        fh.track_edit(str(f))       # 备份 "original"
        f.write_text("after-r1")
        fh.make_snapshot(10)         # snapshot 10: {f: backup="original"}

        # Round 2: agent 再次编辑
        fh.track_edit(str(f))       # 备份 "after-r1"
        f.write_text("after-r2")
        fh.make_snapshot(20)         # snapshot 20: {f: backup="after-r1"}

        # rewind(10): 撤销 snapshot 20 → 从 backup 恢复 "after-r1"
        result = fh.rewind(10)
        assert result["success"] is True
        assert f.read_text() == "after-r1"

    def test_rewind_created_file(self, workspace):
        """创建的文件回退后被删除。"""
        fh = FileHistoryService("sess-rw-2")
        f = workspace / "new.txt"

        # snapshot 1: 文件不存在
        fh.track_edit(str(f))
        fh.make_snapshot(10)

        # 创建文件
        f.write_text("created")

        # 回退到 snapshot 1 之前
        result = fh.rewind(0)
        assert result["success"] is True
        assert not f.exists()

    def test_rewind_no_snapshots_no_pending(self):
        fh = FileHistoryService("sess-rw-3")
        result = fh.rewind(0)
        assert result["success"] is False

    def test_rewind_pending_tracked_files_without_snapshot(self, workspace):
        """最典型场景：agent 执行了工具但还没有新 user message 触发 snapshot。"""
        fh = FileHistoryService("sess-rw-pending")
        f = workspace / "output.txt"

        # 模拟 agent 编辑文件（track_edit 在写入前）
        fh.track_edit(str(f))  # 文件不存在 → created
        f.write_text("agent generated content")

        # 没有调用 make_snapshot（因为还没有新 user message）
        assert not fh._load_snapshots()  # 无已保存的 snapshot
        assert fh.has_snapshots()  # 但有 pending tracked files

        # 用户点回退
        result = fh.rewind(0)
        assert result["success"] is True
        assert result["reverted_files"] == 1
        assert not f.exists()  # created 文件被删除

    def test_rewind_pending_plus_snapshot(self, workspace):
        """有已保存的 snapshot + pending tracked files，同时回退。"""
        fh = FileHistoryService("sess-rw-mixed")
        f = workspace / "data.txt"
        f.write_text("original")

        # Round 1: agent 编辑 → snapshot
        fh.track_edit(str(f))
        f.write_text("v1")
        fh.make_snapshot(10)

        # Round 2: agent 再次编辑 → 还没有 snapshot（pending）
        fh.track_edit(str(f))
        f.write_text("v2")

        # 回退到 round 1 之前
        result = fh.rewind(0)
        assert result["success"] is True
        assert f.read_text() == "original"

    def test_rewind_nothing_to_revert(self, workspace):
        fh = FileHistoryService("sess-rw-4")
        f = workspace / "file.txt"
        f.write_text("hello")
        fh.track_edit(str(f))
        fh.make_snapshot(10)

        # 回退到 seq=10（包含当前，不需要回退）
        result = fh.rewind(10)
        assert result["success"] is True
        assert result["reverted_files"] == 0

    def test_rewind_multi_file(self, workspace):
        """多文件变更的回退。"""
        fh = FileHistoryService("sess-rw-5")
        f1 = workspace / "a.txt"
        f1.write_text("a-original")

        # Round 1: track f1 (modified) 和 f2 (created, 不存在)
        fh.track_edit(str(f1))         # 备份 "a-original"
        fh.track_edit(str(workspace / "b.txt"))  # created, backup=None
        f1.write_text("a-r1")
        (workspace / "b.txt").write_text("b-content")
        fh.make_snapshot(10)

        # Round 2: 修改 f1
        fh.track_edit(str(f1))         # 备份 "a-r1"
        f1.write_text("a-r2")
        fh.make_snapshot(20)

        # rewind(0): 撤销所有 snapshot
        result = fh.rewind(0)
        assert result["success"] is True
        assert f1.read_text() == "a-original"
        assert not (workspace / "b.txt").exists()

    def test_rewind_removes_later_snapshots(self, workspace):
        """回退后删除后续快照记录。"""
        fh = FileHistoryService("sess-rw-6")
        f = workspace / "file.txt"
        f.write_text("v1")
        fh.track_edit(str(f))
        fh.make_snapshot(10)

        f.write_text("v2")
        fh.track_edit(str(f))
        fh.make_snapshot(20)

        f.write_text("v3")
        fh.track_edit(str(f))
        fh.make_snapshot(30)

        fh.rewind(10)
        remaining = fh._load_snapshots()
        assert len(remaining) == 1
        assert remaining[0]["message_seq"] == 10


# ══════════════════════════════════════════════════════════════════════════
#  cleanup / has_snapshots
# ══════════════════════════════════════════════════════════════════════════

class TestCleanup:
    def test_cleanup_removes_all_data(self, workspace):
        fh = FileHistoryService("sess-clean-1")
        f = workspace / "file.txt"
        f.write_text("hello")
        fh.track_edit(str(f))
        fh.make_snapshot(1)

        assert fh._root.exists()
        fh.cleanup()
        assert not fh._root.exists()

    def test_cleanup_no_error_when_empty(self):
        fh = FileHistoryService("sess-clean-2")
        fh.cleanup()  # 不应报错


class TestHasSnapshots:
    def test_false_without_snapshots(self):
        fh = FileHistoryService("sess-has-1")
        assert fh.has_snapshots() is False

    def test_true_after_snapshot(self, workspace):
        fh = FileHistoryService("sess-has-2")
        f = workspace / "file.txt"
        f.write_text("hello")
        fh.track_edit(str(f))
        fh.make_snapshot(1)
        assert fh.has_snapshots() is True


# ══════════════════════════════════════════════════════════════════════════
#  工厂函数
# ══════════════════════════════════════════════════════════════════════════

class TestFactory:
    def test_get_file_history_returns_same_instance(self):
        fh1 = get_file_history("sess-fac-1")
        fh2 = get_file_history("sess-fac-1")
        assert fh1 is fh2

    def test_remove_file_history_cleans_up(self, workspace):
        fh = get_file_history("sess-fac-2")
        f = workspace / "file.txt"
        f.write_text("hello")
        fh.track_edit(str(f))
        fh.make_snapshot(1)

        remove_file_history("sess-fac-2")
        assert "sess-fac-2" not in _instances
        assert not fh._root.exists()

    def test_remove_nonexistent_no_error(self):
        remove_file_history("nonexistent")
