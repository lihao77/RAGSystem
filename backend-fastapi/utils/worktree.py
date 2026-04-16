# -*- coding: utf-8 -*-
"""
Git worktree 隔离管理模块。

对标 Claude Code 的 worktree 隔离方案：
- 为 session 创建独立 git worktree，agent 的文件操作在隔离环境中进行
- 每次 root run 结束时自动 commit 形成 snapshot
- 支持按 snapshot 回滚（git reset --hard）
- session 删除时自动清理 worktree
"""

from __future__ import annotations

import datetime
import json
import logging
import subprocess
from pathlib import Path
from typing import Any, Optional

from core.path_resolution import DATA_ROOT

logger = logging.getLogger(__name__)

WORKTREES_ROOT: Path = DATA_ROOT / "worktrees"


# ── 检测 ──────────────────────────────────────────────────────────

def is_git_repo(path: str) -> bool:
    """检测路径是否在 git 仓库内。"""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=str(path),
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0 and result.stdout.strip() == "true"
    except Exception:
        return False


def is_already_worktree(path: str) -> bool:
    """检测路径是否已经是一个 git worktree（而非主仓库），防止嵌套。"""
    git_path = Path(path) / ".git"
    # worktree 的 .git 是文件（含 gitdir: 指针），主仓库的 .git 是目录
    return git_path.is_file()


# ── 生命周期 ──────────────────────────────────────────────────────

def _meta_path(session_id: str) -> Path:
    return WORKTREES_ROOT / f"{session_id}.meta.json"


def _worktree_dir(session_id: str) -> Path:
    return WORKTREES_ROOT / session_id


def _branch_name(session_id: str) -> str:
    return f"agent/{session_id}"


def create_worktree(original_workspace: str, session_id: str) -> str:
    """为 session 创建 git worktree，返回 worktree 路径。"""
    worktree_path = _worktree_dir(session_id)
    branch = _branch_name(session_id)

    WORKTREES_ROOT.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        ["git", "worktree", "add", "-B", branch, str(worktree_path)],
        cwd=str(original_workspace),
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git worktree add 失败: {result.stderr.strip()}")

    # 写入元数据文件
    meta = {
        "original_workspace": str(original_workspace),
        "session_id": session_id,
        "branch": branch,
        "created_at": datetime.datetime.now().isoformat(),
    }
    _meta_path(session_id).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    logger.info(
        "worktree 创建成功: session=%s path=%s branch=%s",
        session_id, worktree_path, branch,
    )
    return str(worktree_path)


def remove_worktree(session_id: str) -> bool:
    """删除 session 的 worktree 和元数据。"""
    meta_file = _meta_path(session_id)
    worktree_path = _worktree_dir(session_id)

    if not meta_file.exists() and not worktree_path.exists():
        return False

    original_workspace = get_original_workspace(session_id)

    # 尝试 git worktree remove
    if original_workspace and worktree_path.exists():
        try:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree_path)],
                cwd=str(original_workspace),
                capture_output=True, text=True, timeout=30,
            )
        except Exception as exc:
            logger.warning("git worktree remove 失败，回退到目录删除: %s", exc)
            import shutil
            try:
                shutil.rmtree(str(worktree_path), ignore_errors=True)
            except Exception:
                pass
            # prune 残留引用
            if original_workspace:
                try:
                    subprocess.run(
                        ["git", "worktree", "prune"],
                        cwd=str(original_workspace),
                        capture_output=True, timeout=10,
                    )
                except Exception:
                    pass
    elif worktree_path.exists():
        import shutil
        shutil.rmtree(str(worktree_path), ignore_errors=True)

    # 删除分支
    if original_workspace:
        branch = _branch_name(session_id)
        try:
            subprocess.run(
                ["git", "branch", "-D", branch],
                cwd=str(original_workspace),
                capture_output=True, text=True, timeout=10,
            )
        except Exception:
            pass

    # 清理元数据文件
    try:
        meta_file.unlink(missing_ok=True)
    except Exception:
        pass

    logger.info("worktree 已清理: session=%s", session_id)
    return True


def worktree_exists(session_id: str) -> bool:
    """检查 session 的 worktree 是否存在。"""
    return _worktree_dir(session_id).is_dir()


def get_worktree_path(session_id: str) -> Optional[str]:
    """获取 session 的 worktree 路径，不存在则返回 None。"""
    wt = _worktree_dir(session_id)
    return str(wt) if wt.is_dir() else None


def get_original_workspace(session_id: str) -> Optional[str]:
    """从元数据文件读取原始 workspace 路径。"""
    meta_file = _meta_path(session_id)
    if not meta_file.exists():
        return None
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        return meta.get("original_workspace")
    except Exception:
        return None


# ── Snapshot 操作 ─────────────────────────────────────────────────

def create_snapshot(worktree_path: str, *, run_id: Optional[str] = None) -> Optional[str]:
    """
    在 worktree 中执行 git add -A && git commit，形成一个 snapshot。

    仅在有文件变更时才 commit。返回 commit hash，无变更返回 None。
    """
    cwd = str(worktree_path)

    # 检查是否有变更
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=cwd, capture_output=True, text=True, timeout=10,
    )
    if not status.stdout.strip():
        logger.debug("worktree 无变更，跳过 snapshot: %s", worktree_path)
        return None

    # stage all
    subprocess.run(
        ["git", "add", "-A"],
        cwd=cwd, capture_output=True, timeout=10,
    )

    # commit
    message = f"agent snapshot [run:{run_id or 'unknown'}]"
    result = subprocess.run(
        ["git", "commit", "-m", message, "--allow-empty-message"],
        cwd=cwd, capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        logger.warning("snapshot commit 失败: %s", result.stderr.strip())
        return None

    # 获取 commit hash
    rev = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=cwd, capture_output=True, text=True, timeout=5,
    )
    commit_hash = rev.stdout.strip() if rev.returncode == 0 else None

    logger.info("worktree snapshot 创建: commit=%s run_id=%s", commit_hash, run_id)
    return commit_hash


def list_snapshots(worktree_path: str) -> list[dict[str, Any]]:
    """列出 worktree 中的所有 snapshot（git log）。"""
    result = subprocess.run(
        ["git", "log", "--format=%H|%s|%ai|%an", "--no-merges"],
        cwd=str(worktree_path),
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        return []

    snapshots = []
    for line in result.stdout.strip().splitlines():
        parts = line.split("|", 3)
        if len(parts) < 3:
            continue
        commit_hash = parts[0]

        # 获取变更文件数
        stat = subprocess.run(
            ["git", "diff", "--stat", "--name-only", f"{commit_hash}~1..{commit_hash}"],
            cwd=str(worktree_path),
            capture_output=True, text=True, timeout=5,
        )
        files = [f for f in stat.stdout.strip().splitlines() if f] if stat.returncode == 0 else []

        snapshots.append({
            "commit_hash": commit_hash,
            "message": parts[1] if len(parts) > 1 else "",
            "timestamp": parts[2] if len(parts) > 2 else "",
            "files_changed": len(files),
            "files": files[:20],  # 最多返回 20 个文件名
        })
    return snapshots


def get_diff_stats(worktree_path: str, commit_hash: str) -> dict[str, Any]:
    """预览回滚到指定 commit 的影响。"""
    result = subprocess.run(
        ["git", "diff", "--stat", f"{commit_hash}..HEAD"],
        cwd=str(worktree_path),
        capture_output=True, text=True, timeout=10,
    )
    name_result = subprocess.run(
        ["git", "diff", "--name-status", f"{commit_hash}..HEAD"],
        cwd=str(worktree_path),
        capture_output=True, text=True, timeout=10,
    )

    files = []
    if name_result.returncode == 0:
        for line in name_result.stdout.strip().splitlines():
            parts = line.split("\t", 1)
            if len(parts) == 2:
                files.append({"status": parts[0], "file": parts[1]})

    return {
        "target_commit": commit_hash,
        "stat_summary": result.stdout.strip() if result.returncode == 0 else "",
        "files_affected": len(files),
        "files": files[:50],
    }


def rewind_to_snapshot(worktree_path: str, commit_hash: str) -> dict[str, Any]:
    """回滚 worktree 到指定 snapshot（git reset --hard）。"""
    # 先获取影响预览
    diff_stats = get_diff_stats(worktree_path, commit_hash)

    result = subprocess.run(
        ["git", "reset", "--hard", commit_hash],
        cwd=str(worktree_path),
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git reset 失败: {result.stderr.strip()}")

    logger.info("worktree 已回滚: commit=%s files=%d", commit_hash, diff_stats["files_affected"])
    return {
        "success": True,
        "reverted_to": commit_hash,
        "files_affected": diff_stats["files_affected"],
        "files": diff_stats["files"],
    }


def get_current_changes(worktree_path: str) -> str:
    """获取 worktree 中未提交的变更。"""
    result = subprocess.run(
        ["git", "diff"],
        cwd=str(worktree_path),
        capture_output=True, text=True, timeout=10,
    )
    return result.stdout if result.returncode == 0 else ""
