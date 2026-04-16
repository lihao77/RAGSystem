# -*- coding: utf-8 -*-
"""
Git worktree 隔离模块。

为子 Agent 并行执行提供独立 worktree。
文件回退功能已迁移到 services/file_history.py（基于文件备份，不依赖 git）。
"""

import datetime
import json
import logging
import subprocess
from pathlib import Path
from typing import Optional

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
#  Worktree 层（子 Agent 并行隔离）
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
