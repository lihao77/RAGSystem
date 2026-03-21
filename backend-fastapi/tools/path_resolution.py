# -*- coding: utf-8 -*-
"""
全局路径管理中心

将所有文件目录收口到一个可配置的根目录下，提供：
- 一级/二级目录常量
- 数据库路径常量
- Session 级路径生成函数
- 展示路径转换（隐藏绝对路径）
- 启动时目录初始化
"""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

# ── 全局数据根目录 ──────────────────────────────────────────────
BACKEND_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT: Path = Path(os.environ.get("RAG_DATA_ROOT", str(BACKEND_ROOT / "data")))

# ── 一级目录常量 ────────────────────────────────────────────────
DB_ROOT: Path = DATA_ROOT / "db"
ARTIFACTS_ROOT: Path = DATA_ROOT / "artifacts"
TRANSIENT_ROOT: Path = DATA_ROOT / "transient"
EXPORTS_ROOT: Path = DATA_ROOT / "exports"
WORKSPACE_ROOT: Path = DATA_ROOT / "workspace"
MONITORING_ROOT: Path = DATA_ROOT / "monitoring"

# ── 二级目录常量 ────────────────────────────────────────────────
VISUALIZATION_ROOT: Path = ARTIFACTS_ROOT / "visualizations"
TRANSIENT_ARTIFACTS_ROOT: Path = TRANSIENT_ROOT / "scratch"
CODE_EXECUTION_ROOT: Path = TRANSIENT_ROOT / "code_execution"
SESSION_TRACES_ROOT: Path = MONITORING_ROOT / "session_traces"

# ── 数据库路径常量 ──────────────────────────────────────────────
RAGSYSTEM_DB: Path = DB_ROOT / "ragsystem.db"
CHECKPOINTS_DB: Path = DB_ROOT / "checkpoints.db"


# ── Session 级路径生成函数 ──────────────────────────────────────

def get_code_execution_session_root(session_id: str) -> Path:
    """获取代码沙箱的 session 级目录。"""
    return CODE_EXECUTION_ROOT / session_id


def get_export_run_root(session_id: str, run_id: str) -> Path:
    """获取导出文件的 session/run 级目录。"""
    return EXPORTS_ROOT / session_id / run_id


def _get_workspace_session_root(session_id: str) -> Path:
    """获取用户工作空间的 session 级目录。"""
    return WORKSPACE_ROOT / session_id


def _get_transient_session_root(session_id: str) -> Path:
    """获取 transient scratch 的 session 级目录（替代 tempfile.gettempdir()）。"""
    return TRANSIENT_ARTIFACTS_ROOT / session_id


# ── 文档工具路径预处理 ────────────────────────────────────────────

_DISPLAY_PATH_PREFIX = "./data/"


def _from_display_path(file_path: str) -> Path | None:
    """将 ./data/... 展示路径反向映射回绝对路径，无法映射时返回 None。"""
    if file_path.startswith(_DISPLAY_PATH_PREFIX):
        relative = file_path[len(_DISPLAY_PATH_PREFIX):]
        return DATA_ROOT / relative
    return None


def resolve_document_input_path(
    file_path: str,
    *,
    workspace_root: str | None = None,
    sandbox_root: Path | None = None,
) -> Path:
    """
    将文档工具的输入路径统一解析为绝对路径。

    解析优先级：
    1. 已经是绝对路径 → 直接 resolve
    2. ./data/... 展示路径 → 反向映射到 DATA_ROOT
    3. sandbox_root（caller=code_execution 时）→ sandbox_root / relative
    4. workspace_root（agent_config 配置）→ workspace_root / relative
    5. DATA_ROOT fallback → DATA_ROOT / relative

    注意：此函数只做路径归一化，不做安全边界校验（那是 sandbox 的职责）。
    """
    p = Path(file_path)

    # 1. 绝对路径
    if p.is_absolute():
        return p.resolve()

    # 2. ./data/... 展示路径反向映射
    mapped = _from_display_path(file_path)
    if mapped is not None:
        return mapped.resolve()

    # 3. sandbox_root 优先（code_execution 场景）
    # 4. workspace_root
    # 先检查文件是否存在（读场景），再 fallback 到第一个可用 root（写场景）
    _candidate_roots = []
    if sandbox_root is not None:
        _candidate_roots.append(sandbox_root)
    if workspace_root is not None:
        _candidate_roots.append(Path(workspace_root))

    for root in _candidate_roots:
        candidate = (root / file_path).resolve()
        if candidate.exists():
            return candidate

    # 写场景：文件不存在，返回第一个可用 root 的拼接结果
    if _candidate_roots:
        return (_candidate_roots[0] / file_path).resolve()

    # 5. DATA_ROOT fallback
    return (DATA_ROOT / file_path).resolve()


def assign_document_output_path(
    *,
    session_id: str | None = None,
    run_id: str | None = None,
    default_output_space: str | None = None,
    suffix: str = ".txt",
) -> Path:
    """
    为 write_file 在未指定 file_path 时分配受管绝对路径。

    分配策略：
    - exports（有 session_id + run_id）→ EXPORTS_ROOT/session/run/
    - workspace（有 session_id）→ WORKSPACE_ROOT/session/
    - 默认 → TRANSIENT_ARTIFACTS_ROOT/session/ （不再落到系统 temp）
    """
    if default_output_space == "exports" and session_id and run_id:
        root = get_export_run_root(session_id, run_id)
    elif default_output_space == "workspace" and session_id:
        root = _get_workspace_session_root(session_id)
    elif session_id:
        root = _get_transient_session_root(session_id)
    else:
        # 无 session 兜底：仍落在 transient scratch 下，用 pid 隔离
        root = TRANSIENT_ARTIFACTS_ROOT / "anonymous"

    root.mkdir(parents=True, exist_ok=True)
    return root / f"output_{uuid.uuid4().hex[:12]}{suffix}"


# ── 展示路径转换 ────────────────────────────────────────────────

def to_display_path(absolute_path: Path | str) -> str:
    """将绝对路径转换为相对于 DATA_ROOT 的展示路径，隐藏服务器绝对路径。"""
    p = Path(absolute_path).resolve()
    try:
        relative = p.relative_to(DATA_ROOT.resolve())
        return f"{_DISPLAY_PATH_PREFIX}{relative.as_posix()}"
    except ValueError:
        # 非 DATA_ROOT 子路径，返回 posix 格式绝对路径
        return p.as_posix()


# ── 启动时初始化 ────────────────────────────────────────────────

_ALL_DIRS = [
    DB_ROOT,
    ARTIFACTS_ROOT,
    VISUALIZATION_ROOT,
    TRANSIENT_ROOT,
    TRANSIENT_ARTIFACTS_ROOT,
    CODE_EXECUTION_ROOT,
    EXPORTS_ROOT,
    WORKSPACE_ROOT,
    MONITORING_ROOT,
    SESSION_TRACES_ROOT,
]


def ensure_directories() -> None:
    """创建所有必要目录。"""
    for d in _ALL_DIRS:
        d.mkdir(parents=True, exist_ok=True)
