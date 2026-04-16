# -*- coding: utf-8 -*-
"""
Git worktree 隔离模块。

为子 Agent 并行执行提供仓库内 repo-local worktree。
文件回退功能已迁移到 services/file_history.py（基于文件备份，不依赖 git）。
"""

import datetime
import json
import logging
import re
import shutil
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_CHILD_ID_RE = re.compile(r'^[a-zA-Z0-9_-]+$')


# ── 内部辅助 ────────────────────────────────────────────────────────────────

def _validate_child_agent_id(child_agent_id: str) -> None:
    if not child_agent_id or not _CHILD_ID_RE.match(child_agent_id):
        raise ValueError(f"非法 child_agent_id: {child_agent_id!r}")


def _run_git(args: list[str], *, cwd: str, timeout: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _repo_root(path: str) -> Optional[Path]:
    p = Path(path)
    if not p.is_dir():
        return None
    try:
        result = _run_git(["rev-parse", "--show-toplevel"], cwd=str(p), timeout=5)
        if result.returncode != 0:
            return None
        return Path(result.stdout.strip()).resolve()
    except Exception:
        return None


def _main_repo_root(path: str) -> Optional[Path]:
    repo_root = _repo_root(path)
    if repo_root is None:
        return None
    if not is_already_worktree(str(repo_root)):
        return repo_root
    try:
        result = _run_git(["rev-parse", "--git-common-dir"], cwd=str(repo_root), timeout=5)
        if result.returncode != 0:
            return repo_root
        common_dir = Path(result.stdout.strip()).resolve()
        if common_dir.name == ".git":
            return common_dir.parent.resolve()
        return repo_root
    except Exception:
        return repo_root


def _resolve_root(original_workspace: str, _resolved_root: Optional[Path] = None) -> Path:
    """解析 repo root，优先使用已缓存的 _resolved_root。"""
    if _resolved_root is not None:
        return _resolved_root
    root = _main_repo_root(original_workspace)
    if root is None:
        raise RuntimeError(f"无法解析 git 仓库根目录: {original_workspace}")
    return root


def _worktrees_root_from(repo_root: Path) -> Path:
    return repo_root / ".ragsystem" / "worktrees"


def _worktree_dir(original_workspace: str, child_agent_id: str, *, _resolved_root: Optional[Path] = None) -> Path:
    root = _resolve_root(original_workspace, _resolved_root)
    return _worktrees_root_from(root) / child_agent_id


def _meta_path(original_workspace: str, child_agent_id: str, *, _resolved_root: Optional[Path] = None) -> Path:
    root = _resolve_root(original_workspace, _resolved_root)
    return _worktrees_root_from(root) / f"{child_agent_id}.meta.json"


def _branch_name(child_agent_id: str) -> str:
    return f"agent/{child_agent_id}"


# ── 检测辅助 ────────────────────────────────────────────────────────────────

def is_git_repo(path: str) -> bool:
    """检测目录是否在 git 仓库内。"""
    p = Path(path)
    if not p.is_dir():
        return False
    try:
        result = _run_git(["rev-parse", "--is-inside-work-tree"], cwd=str(p), timeout=5)
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
        common_result = _run_git(["rev-parse", "--git-common-dir"], cwd=str(p), timeout=5)
        if common_result.returncode != 0:
            return False
        git_dir_result = _run_git(["rev-parse", "--git-dir"], cwd=str(p), timeout=5)
        if git_dir_result.returncode != 0:
            return False
        common = Path(common_result.stdout.strip()).resolve()
        git_d = Path(git_dir_result.stdout.strip()).resolve()
        return common != git_d
    except Exception:
        return False


# ══════════════════════════════════════════════════════════════════════════
#  Worktree 层（子 Agent 并行隔离）
# ══════════════════════════════════════════════════════════════════════════

def create_worktree(original_workspace: str, child_agent_id: str) -> str:
    """为 child agent 创建仓库内 repo-local worktree。"""
    _validate_child_agent_id(child_agent_id)

    repo_root = _main_repo_root(original_workspace)
    if repo_root is None:
        raise RuntimeError(f"无法解析 git 仓库根目录: {original_workspace}")

    worktree_path = _worktree_dir(original_workspace, child_agent_id, _resolved_root=repo_root)
    branch = _branch_name(child_agent_id)
    meta_file = _meta_path(original_workspace, child_agent_id, _resolved_root=repo_root)

    if worktree_path.exists():
        logger.info("worktree 已存在: %s", worktree_path)
        return str(worktree_path)

    worktree_path.parent.mkdir(parents=True, exist_ok=True)
    result = _run_git(
        ["worktree", "add", "-B", branch, str(worktree_path)],
        cwd=str(repo_root),
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git worktree add 失败: {result.stderr.strip()}")

    meta = {
        "original_workspace": str(repo_root),
        "child_agent_id": child_agent_id,
        "type": "worktree",
        "branch": branch,
        "worktree_path": str(worktree_path),
        "created_at": datetime.datetime.now().isoformat(),
    }
    meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("worktree 已创建: %s (branch=%s)", worktree_path, branch)
    return str(worktree_path)


def remove_worktree(original_workspace: str, child_agent_id: str) -> bool:
    """移除 child agent 对应的 repo-local worktree 和分支。"""
    _validate_child_agent_id(child_agent_id)

    repo_root = _main_repo_root(original_workspace)
    if repo_root is None:
        return False

    worktree_path = _worktree_dir(original_workspace, child_agent_id, _resolved_root=repo_root)
    meta_file = _meta_path(original_workspace, child_agent_id, _resolved_root=repo_root)
    if not worktree_path.exists() and not meta_file.exists():
        return False

    if worktree_path.exists():
        try:
            result = _run_git(
                ["worktree", "remove", "--force", str(worktree_path)],
                cwd=str(repo_root),
                timeout=30,
            )
            if result.returncode != 0:
                shutil.rmtree(str(worktree_path), ignore_errors=True)
        except Exception as exc:
            logger.warning("worktree remove 失败: %s", exc)
            shutil.rmtree(str(worktree_path), ignore_errors=True)

    branch = _branch_name(child_agent_id)
    try:
        _run_git(["branch", "-D", branch], cwd=str(repo_root), timeout=10)
    except Exception:
        pass

    meta_file.unlink(missing_ok=True)
    logger.info("worktree 已清理: child_agent_id=%s", child_agent_id)
    return True


# ── Worktree 查询辅助 ──────────────────────────────────────────────────────

def worktree_exists(original_workspace: str, child_agent_id: str) -> bool:
    """检查 child agent 是否有对应的 worktree 目录。"""
    try:
        return _worktree_dir(original_workspace, child_agent_id).is_dir()
    except Exception:
        return False


def get_worktree_path(original_workspace: str, child_agent_id: str) -> Optional[str]:
    """获取 child agent 的 worktree 路径，不存在则返回 None。"""
    try:
        d = _worktree_dir(original_workspace, child_agent_id)
    except Exception:
        return None
    return str(d) if d.is_dir() else None


def get_original_workspace(original_workspace: str, child_agent_id: str) -> Optional[str]:
    """从 meta 获取原始 workspace 路径。"""
    try:
        meta_file = _meta_path(original_workspace, child_agent_id)
    except Exception:
        return None
    if not meta_file.exists():
        return None
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        return meta.get("original_workspace")
    except Exception:
        return None
