# -*- coding: utf-8 -*-
"""
文件级备份与回退服务。

对标 Claude Code 的 fileHistory 方案：编辑前备份原文件到配置目录，
回退时从备份恢复。不依赖 git，不碰用户仓库。

存储结构：
    DATA_ROOT/file-history/{session_id}/
      ├── snapshots.json     # 快照索引
      └── backups/
          ├── {sha256_hash}  # 文件内容备份（按内容 hash 去重）
          └── ...
"""

import hashlib
import json
import logging
import os
import shutil
import uuid
from pathlib import Path
from typing import Any, Optional

from core.path_resolution import DATA_ROOT

logger = logging.getLogger(__name__)

FILE_HISTORY_ROOT = DATA_ROOT / "file-history"


class FileHistoryService:
    """Session 级文件备份与回退。"""

    def __init__(self, session_id: str):
        self._session_id = session_id
        self._root = FILE_HISTORY_ROOT / session_id
        self._backups_dir = self._root / "backups"
        self._snapshots_file = self._root / "snapshots.json"
        # 当前轮次追踪的文件变更（尚未 snapshot）
        # {abs_path: {"backup_hash": str|None, "action": "modified"|"created"}}
        self._tracked: dict[str, dict[str, Any]] = {}

    # ── 备份辅助 ─────────────────────────────────────────────────

    def _ensure_dirs(self) -> None:
        self._backups_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _content_hash(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def _backup_file(self, file_path: str) -> Optional[str]:
        """备份文件内容到 backups/{hash}，返回 hash；文件不存在返回 None。"""
        p = Path(file_path)
        if not p.is_file():
            return None
        data = p.read_bytes()
        h = self._content_hash(data)
        backup_path = self._backups_dir / h
        if not backup_path.exists():
            self._ensure_dirs()
            backup_path.write_bytes(data)
        return h

    def _restore_file(self, file_path: str, backup_hash: Optional[str]) -> None:
        """从备份恢复文件。backup_hash 为 None 表示文件原本不存在（需删除）。"""
        p = Path(file_path)
        if backup_hash is None:
            # 文件原本不存在 → 删除
            if p.exists():
                p.unlink()
                logger.debug("file_history: 已删除文件 %s", file_path)
            return
        backup_path = self._backups_dir / backup_hash
        if not backup_path.exists():
            logger.warning("file_history: 备份文件缺失 hash=%s path=%s", backup_hash, file_path)
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(backup_path), str(p))
        logger.debug("file_history: 已恢复文件 %s (hash=%s)", file_path, backup_hash[:12])

    # ── 快照索引读写 ────────────────────────────────────────────

    def _load_snapshots(self) -> list[dict[str, Any]]:
        if not self._snapshots_file.exists():
            return []
        try:
            return json.loads(self._snapshots_file.read_text(encoding="utf-8"))
        except Exception:
            return []

    def _save_snapshots(self, snapshots: list[dict[str, Any]]) -> None:
        self._ensure_dirs()
        self._snapshots_file.write_text(
            json.dumps(snapshots, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # ── 公开 API ─────────────────────────────────────────────────

    def track_edit(self, file_path: str) -> None:
        """
        编辑 / 写入前调用：备份原文件内容。

        - 文件已存在 → 记为 modified，备份内容
        - 文件不存在 → 记为 created（回退时删除）

        同一轮内对同一文件只备份一次（首次状态）。
        """
        abs_path = str(Path(file_path).resolve())
        if abs_path in self._tracked:
            return  # 已追踪，不覆盖首次备份

        p = Path(abs_path)
        if p.is_file():
            backup_hash = self._backup_file(abs_path)
            self._tracked[abs_path] = {
                "backup_hash": backup_hash,
                "action": "modified",
            }
            logger.debug("file_history: track modified %s (hash=%s)", abs_path, backup_hash and backup_hash[:12])
        else:
            self._tracked[abs_path] = {
                "backup_hash": None,
                "action": "created",
            }
            logger.debug("file_history: track created %s", abs_path)

    def make_snapshot(self, message_seq: int) -> Optional[str]:
        """
        用户消息提交时调用：记录当前 tracked files 状态。

        Returns:
            snapshot_id（UUID），无追踪文件时返回 None
        """
        if not self._tracked:
            return None

        snapshot_id = uuid.uuid4().hex[:16]
        snapshot = {
            "snapshot_id": snapshot_id,
            "message_seq": message_seq,
            "tracked_files": dict(self._tracked),
            "created_at": _now_iso(),
        }

        snapshots = self._load_snapshots()
        snapshots.append(snapshot)
        self._save_snapshots(snapshots)

        logger.info(
            "file_history: snapshot created id=%s seq=%s files=%d",
            snapshot_id, message_seq, len(self._tracked),
        )
        # 清空追踪，下一轮重新开始
        self._tracked.clear()
        return snapshot_id

    def rewind(self, target_seq: int) -> dict[str, Any]:
        """
        回退到 target_seq 对应的快照状态。

        包含两部分回退：
        1. 已快照的 tracked files（message_seq > target_seq 的 snapshot）
        2. 当前未快照的 pending tracked files（agent 正在执行中的变更）

        Returns:
            {"success": bool, "message": str, "reverted_files": int}
        """
        snapshots = self._load_snapshots()
        pending = dict(self._tracked)  # 当前未快照的 tracked files

        if not snapshots and not pending:
            return {"success": False, "message": "无可用快照且无 pending 变更", "reverted_files": 0}

        # 找到需要回退的 snapshot（message_seq > target_seq 的全部）
        to_revert = [s for s in snapshots if s["message_seq"] > target_seq]

        # 收集每个文件的最早备份（代表变更前的原始状态）
        # 按时间正序遍历，首次出现的备份即为最初始状态
        file_restore_map: dict[str, Optional[str]] = {}
        for snap in to_revert:  # to_revert 已按 seq 正序
            for file_path, info in snap["tracked_files"].items():
                if file_path not in file_restore_map:
                    file_restore_map[file_path] = info.get("backup_hash")

        # 合并 pending tracked files（未快照的当前执行轮次变更）
        for file_path, info in pending.items():
            if file_path not in file_restore_map:
                file_restore_map[file_path] = info.get("backup_hash")

        if not file_restore_map:
            return {"success": True, "message": "无需回退", "reverted_files": 0}

        # 恢复每个文件
        for file_path, backup_hash in file_restore_map.items():
            self._restore_file(file_path, backup_hash)

        # 保留 target_seq 及之前的快照
        remaining = [s for s in snapshots if s["message_seq"] <= target_seq]
        self._save_snapshots(remaining)
        # 清空当前追踪
        self._tracked.clear()

        logger.info(
            "file_history: rewind to seq=%d, reverted %d files (snapshots=%d, pending=%d)",
            target_seq, len(file_restore_map), len(to_revert), len(pending),
        )
        return {
            "success": True,
            "message": f"已回退到 seq={target_seq}，恢复了 {len(file_restore_map)} 个文件",
            "reverted_files": len(file_restore_map),
        }

    def cleanup(self) -> None:
        """Session 删除时清理所有备份数据。"""
        if self._root.exists():
            shutil.rmtree(str(self._root), ignore_errors=True)
            logger.info("file_history: cleaned up session=%s", self._session_id)

    def has_snapshots(self) -> bool:
        """是否有任何快照记录或 pending tracked files。"""
        return bool(self._load_snapshots()) or bool(self._tracked)

    def list_snapshots(self) -> list[dict[str, Any]]:
        """列出所有快照。"""
        return self._load_snapshots()


# ── 工厂 / 缓存 ─────────────────────────────────────────────────

_instances: dict[str, FileHistoryService] = {}


def get_file_history(session_id: str) -> FileHistoryService:
    """获取或创建 session 的 FileHistoryService 实例。"""
    if session_id not in _instances:
        _instances[session_id] = FileHistoryService(session_id)
    return _instances[session_id]


def remove_file_history(session_id: str) -> None:
    """移除缓存实例（session 删除后调用）。"""
    inst = _instances.pop(session_id, None)
    if inst:
        inst.cleanup()


def _now_iso() -> str:
    import datetime
    return datetime.datetime.now().isoformat()
