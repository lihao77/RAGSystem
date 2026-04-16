# -*- coding: utf-8 -*-
"""
Git snapshot 回退与 worktree 隔离模块。

分为两层：
- **Snapshot 层**（所有场景通用）：入口 agent 直接在用户原目录操作，
  通过 git 记录变更历史，支持 per-run snapshot 与按 commit 回滚。
- **Worktree 层**（保留给 D5 子 Agent 并行）：为子 agent 创建独立 worktree。
"""

import datetime
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any, Optional

from core.path_resolution import DATA_ROOT

logger = logging.getLogger(__name__)

# ── 常量 ──────────────────────────────────────────────────────────────────

WORKTREES_ROOT = DATA_ROOT / "worktrees"


# ── 内部辅助 ────────────────────────────────────────────────────────────────

def _worktree_dir(session_id: str) -> Path:
    return WORKTREES_ROOT / session_id


def _meta_path(session_id: str) -> Path:
    return WORKTREES_ROOT / f"{session_id}.meta.json"


def _branch_name(session_id: str) -> str:
    return f"agent/{session_id}"


# ── 检测辅助 ────────────────────────────────────────────────────────────────

def is_git_repo(path: str) -> bool:
    """检测目录是否在 git 仓库内。"""
    p = Path(path)
    if not p.is_dir():
        return False
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=str(p),
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0 and result.stdout.strip() == "true"
    except Exception:
        return False


def is_already_worktree(path: str) -> bool:
    """检测目录是否已经是一个 worktree（而非主仓库）。"""
    p = Path(path)
    git_dir = p / ".git"
    if git_dir.is_file():
        return True
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=str(p),
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return False
        common = Path(result.stdout.strip()).resolve()
        git_dir_result = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=str(p),
            capture_output=True, text=True, timeout=5,
        )
        if git_dir_result.returncode != 0:
            return False
        git_d = Path(git_dir_result.stdout.strip()).resolve()
        return common != git_d
    except Exception:
        return False


# ══════════════════════════════════════════════════════════════════════════
#  Snapshot 层（所有场景通用）
# ══════════════════════════════════════════════════════════════════════════

def ensure_git_snapshot(workspace_path: str, session_id: str) -> bool:
    """
    确保 workspace 具有 git snapshot 能力。

    - 已是 git repo → 直接可用，仅写 meta
    - 非 git 目录 → git init + 初始 commit

    Returns:
        True 表示 snapshot 已就绪
    """
    if is_git_repo(workspace_path):
        _ensure_snapshot_meta(workspace_path, session_id)
        return True

    # 非 git 目录：就地 git init
    path = Path(workspace_path)
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init"],
        cwd=str(path), capture_output=True, timeout=10,
    )
    subprocess.run(
        ["git", "config", "user.email", "agent@ragsystem.local"],
        cwd=str(path), capture_output=True, timeout=5,
    )
    subprocess.run(
        ["git", "config", "user.name", "RAG Agent"],
        cwd=str(path), capture_output=True, timeout=5,
    )
    # .gitignore
    gitignore = path / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("__pycache__/\n*.pyc\n.DS_Store\nThumbs.db\n")
    subprocess.run(["git", "add", "-A"], cwd=str(path), capture_output=True, timeout=10)
    subprocess.run(
        ["git", "commit", "-m", "initial workspace", "--allow-empty"],
        cwd=str(path), capture_output=True, text=True, timeout=15,
    )
    _ensure_snapshot_meta(workspace_path, session_id, git_initialized=True)
    logger.info("git snapshot 已启用 (git init): session=%s path=%s", session_id, workspace_path)
    return True


def _ensure_snapshot_meta(workspace_path: str, session_id: str, *, git_initialized: bool = False):
    """写入 snapshot meta（追踪 session 与 workspace 的关联）。"""
    meta_file = _meta_path(session_id)
    # 已有 meta 且 workspace 一致 → 跳过
    if meta_file.exists():
        try:
            existing = json.loads(meta_file.read_text(encoding="utf-8"))
            if existing.get("original_workspace") == str(workspace_path):
                return
        except Exception:
            pass

    WORKTREES_ROOT.mkdir(parents=True, exist_ok=True)
    meta = {
        "original_workspace": str(workspace_path),
        "session_id": session_id,
        "type": "snapshot",
        "git_initialized": git_initialized,
        "created_at": datetime.datetime.now().isoformat(),
    }
    meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def snapshot_enabled(session_id: str) -> bool:
    """检查 session 是否已启用 snapshot。"""
    return _meta_path(session_id).exists()


def get_snapshot_workspace(session_id: str) -> Optional[str]:
    """获取 session 的 snapshot 工作目录。"""
    meta_file = _meta_path(session_id)
    if not meta_file.exists():
        return None
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        ws = meta.get("original_workspace")
        if ws and Path(ws).is_dir():
            return ws
    except Exception:
        pass
    return None


def cleanup_snapshot(session_id: str) -> None:
    """清理 snapshot 元数据。如果是我们 git init 的，也清理 .git。"""
    meta_file = _meta_path(session_id)
    if not meta_file.exists():
        return
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        if meta.get("git_initialized"):
            git_dir = Path(meta["original_workspace"]) / ".git"
            if git_dir.is_dir():
                import shutil
                import stat
                def _rm_readonly(func, path, _exc_info):
                    """Windows: 移除只读属性后重试删除。"""
                    os.chmod(path, stat.S_IWRITE)
                    func(path)
                shutil.rmtree(str(git_dir), onerror=_rm_readonly)
                logger.info("已清理 agent 创建的 .git: %s", meta["original_workspace"])
            # 也清理 .gitignore（我们创建的）
            gitignore = Path(meta["original_workspace"]) / ".gitignore"
            if gitignore.exists():
                gitignore.unlink(missing_ok=True)
    except Exception as e:
        logger.debug("cleanup_snapshot 清理 .git 失败: %s", e)
    meta_file.unlink(missing_ok=True)


# ── Snapshot 操作（通用，只需一个 git 目录路径）──────────────────────────────

def create_snapshot(workspace_path: str, *, run_id: Optional[str] = None) -> Optional[str]:
    """
    在 workspace 中创建 snapshot（git add + commit）。

    Returns:
        commit hash（短），无变更时返回 None
    """
    cwd = str(workspace_path)

    # 检查是否有变更
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=cwd, capture_output=True, text=True, timeout=10,
    )
    if not status.stdout.strip():
        return None

    # stage + commit
    subprocess.run(["git", "add", "-A"], cwd=cwd, capture_output=True, timeout=10)
    message = f"agent snapshot (run={run_id})" if run_id else "agent snapshot"
    result = subprocess.run(
        ["git", "commit", "-m", message, "--allow-empty-message"],
        cwd=cwd, capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        logger.warning("snapshot commit 失败: %s", result.stderr.strip())
        return None

    # 获取 commit hash
    hash_result = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=cwd, capture_output=True, text=True, timeout=5,
    )
    commit_hash = hash_result.stdout.strip()
    logger.info("snapshot 已创建: %s (run=%s)", commit_hash, run_id)
    return commit_hash


def list_snapshots(workspace_path: str) -> list[dict[str, Any]]:
    """列出 workspace 中所有 snapshot commit。"""
    result = subprocess.run(
        ["git", "log", "--oneline", "--format=%H|%h|%s|%ci"],
        cwd=str(workspace_path),
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        return []

    snapshots = []
    for line in result.stdout.strip().splitlines():
        parts = line.split("|", 3)
        if len(parts) == 4:
            snapshots.append({
                "hash": parts[0],
                "short_hash": parts[1],
                "message": parts[2],
                "date": parts[3],
            })
    return snapshots


def get_diff_stats(workspace_path: str, commit_hash: str) -> Optional[str]:
    """获取某个 commit 相对前一个 commit 的 diff 统计。"""
    result = subprocess.run(
        ["git", "diff", "--stat", f"{commit_hash}~1", commit_hash],
        cwd=str(workspace_path),
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def get_current_changes(workspace_path: str) -> Optional[str]:
    """获取当前未提交的变更摘要。"""
    result = subprocess.run(
        ["git", "status", "--short"],
        cwd=str(workspace_path),
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def rewind_to_snapshot(workspace_path: str, commit_hash: str) -> dict[str, Any]:
    """
    回滚到指定 snapshot。

    Returns:
        {"success": bool, "message": str}
    """
    result = subprocess.run(
        ["git", "reset", "--hard", commit_hash],
        cwd=str(workspace_path),
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        return {"success": False, "message": f"回滚失败: {result.stderr.strip()}"}

    logger.info("已回滚到 snapshot: %s", commit_hash)
    return {"success": True, "message": f"已回滚到 {commit_hash}"}


# ══════════════════════════════════════════════════════════════════════════
#  Worktree 层（保留给 D5 子 Agent 并行）
# ══════════════════════════════════════════════════════════════════════════

def create_worktree(original_workspace: str, session_id: str) -> str:
    """
    为 session 创建独立 worktree（用于子 agent 隔离）。

    Returns:
        worktree 路径字符串
    """
    worktree_path = _worktree_dir(session_id)
    branch = _branch_name(session_id)

    if worktree_path.exists():
        logger.info("worktree 已存在: %s", worktree_path)
        return str(worktree_path)

    worktree_path.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "worktree", "add", "-B", branch, str(worktree_path)],
        cwd=str(original_workspace),
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git worktree add 失败: {result.stderr.strip()}")

    # 写 meta
    meta = {
        "original_workspace": str(original_workspace),
        "session_id": session_id,
        "type": "worktree",
        "branch": branch,
        "created_at": datetime.datetime.now().isoformat(),
    }
    _meta_path(session_id).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    logger.info("worktree 已创建: %s (branch=%s)", worktree_path, branch)
    return str(worktree_path)


def remove_worktree(session_id: str) -> bool:
    """移除 session 对应的 worktree 和分支。"""
    worktree_path = _worktree_dir(session_id)
    meta_file = _meta_path(session_id)

    if not worktree_path.exists() and not meta_file.exists():
        return False

    original = get_original_workspace(session_id)

    # 移除 worktree
    if worktree_path.exists():
        try:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree_path)],
                cwd=str(original) if original else str(worktree_path),
                capture_output=True, text=True, timeout=30,
            )
        except Exception as e:
            logger.warning("worktree remove 失败: %s", e)
            import shutil
            shutil.rmtree(str(worktree_path), ignore_errors=True)

    # 删除分支
    branch = _branch_name(session_id)
    if original:
        try:
            subprocess.run(
                ["git", "branch", "-D", branch],
                cwd=str(original),
                capture_output=True, text=True, timeout=10,
            )
        except Exception:
            pass

    # 清理 meta
    meta_file.unlink(missing_ok=True)
    logger.info("worktree 已清理: session=%s", session_id)
    return True


# ── Worktree 查询辅助 ──────────────────────────────────────────────────────

def worktree_exists(session_id: str) -> bool:
    """检查 session 是否有对应的 worktree 目录。"""
    return _worktree_dir(session_id).is_dir()


def get_worktree_path(session_id: str) -> Optional[str]:
    """获取 session 的 worktree 路径，不存在则返回 None。"""
    d = _worktree_dir(session_id)
    return str(d) if d.is_dir() else None


def get_original_workspace(session_id: str) -> Optional[str]:
    """从 meta 获取原始 workspace 路径。"""
    meta_file = _meta_path(session_id)
    if not meta_file.exists():
        return None
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        return meta.get("original_workspace")
    except Exception:
        return None
