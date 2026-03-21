# -*- coding: utf-8 -*-
"""
全局路径管理中心。

将受管文件路径统一收口到 session 目录模型，提供：
- 数据根目录与数据库路径常量
- session 级目录生成函数
- direct / code_execution 共用的受管路径解析
- 展示路径转换（隐藏服务器绝对路径）
- 资源 scope 推断
- 启动时目录初始化
"""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)

# ── 全局数据根目录 ──────────────────────────────────────────────
BACKEND_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT: Path = Path(os.environ.get("RAG_DATA_ROOT", str(BACKEND_ROOT / "data")))

# ── 一级目录常量 ────────────────────────────────────────────────
DB_ROOT: Path = DATA_ROOT / "db"
MONITORING_ROOT: Path = DATA_ROOT / "monitoring"
SESSIONS_ROOT: Path = DATA_ROOT / "sessions"

# ── 监控/数据库路径常量 ─────────────────────────────────────────
SESSION_TRACES_ROOT: Path = MONITORING_ROOT / "session_traces"
RAGSYSTEM_DB: Path = DB_ROOT / "ragsystem.db"
CHECKPOINTS_DB: Path = DB_ROOT / "checkpoints.db"

# ── 兼容历史目录（仅用于只读 fallback / scope 推断）─────────────
_LEGACY_ARTIFACTS_ROOT: Path = DATA_ROOT / "artifacts"
_LEGACY_TRANSIENT_ROOT: Path = DATA_ROOT / "transient"
_LEGACY_EXPORTS_ROOT: Path = DATA_ROOT / "exports"
_LEGACY_WORKSPACE_ROOT: Path = DATA_ROOT / "workspace"
_LEGACY_VISUALIZATION_ROOT: Path = _LEGACY_ARTIFACTS_ROOT / "visualizations"
_LEGACY_TRANSIENT_ARTIFACTS_ROOT: Path = _LEGACY_TRANSIENT_ROOT / "scratch"
_LEGACY_CODE_EXECUTION_ROOT: Path = _LEGACY_TRANSIENT_ROOT / "code_execution"

_DISPLAY_PATH_PREFIX = "./data/"
_ANONYMOUS_SESSION_ID = "anonymous"
_READ_OPERATIONS = {"read"}
_WRITE_OPERATIONS = {"write", "edit", "output"}
_VALID_OPERATIONS = _READ_OPERATIONS | _WRITE_OPERATIONS


def _normalize_session_id(session_id: str | None, *, required: bool = False, feature: str = "路径解析") -> str | None:
    value = (session_id or "").strip()
    if value:
        return value
    if required:
        raise ValueError(f"{feature}缺少 session_id")
    return None


def _normalize_run_id(run_id: str | None) -> str | None:
    value = (run_id or "").strip()
    return value or None


def _anonymous_session_root() -> Path:
    return SESSIONS_ROOT / _ANONYMOUS_SESSION_ID


# ── 兼容导出常量（新代码请优先使用 session 函数）───────────────
ARTIFACTS_ROOT: Path = _LEGACY_ARTIFACTS_ROOT
TRANSIENT_ROOT: Path = _LEGACY_TRANSIENT_ROOT
EXPORTS_ROOT: Path = _LEGACY_EXPORTS_ROOT
WORKSPACE_ROOT: Path = _LEGACY_WORKSPACE_ROOT
VISUALIZATION_ROOT: Path = _LEGACY_VISUALIZATION_ROOT
TRANSIENT_ARTIFACTS_ROOT: Path = _anonymous_session_root() / "transient"
CODE_EXECUTION_ROOT: Path = _anonymous_session_root() / "sandbox"


# ── Session 级路径生成函数 ──────────────────────────────────────

def get_session_root(session_id: str) -> Path:
    return SESSIONS_ROOT / _normalize_session_id(session_id, required=True, feature="session 根目录")


def get_session_sandbox_root(session_id: str) -> Path:
    return get_session_root(session_id) / "sandbox"


def get_session_workspace_root(session_id: str) -> Path:
    return get_session_root(session_id) / "workspace"


def get_session_transient_root(session_id: str) -> Path:
    return get_session_root(session_id) / "transient"


def get_session_uploads_root(session_id: str) -> Path:
    return get_session_root(session_id) / "uploads"


def get_session_visualizations_root(session_id: str) -> Path:
    return get_session_root(session_id) / "visualizations"


def get_session_exports_root(session_id: str) -> Path:
    return get_session_root(session_id) / "exports"


def get_export_run_root(session_id: str, run_id: str) -> Path:
    normalized_run_id = _normalize_run_id(run_id)
    if not normalized_run_id:
        raise ValueError("导出目录缺少 run_id")
    return get_session_exports_root(session_id) / normalized_run_id


def get_session_cleanup_root(session_id: str) -> Path:
    return get_session_root(session_id)


# 兼容旧调用名，便于渐进迁移
get_code_execution_session_root = get_session_sandbox_root


def _from_display_path(file_path: str) -> Path | None:
    if file_path.startswith(_DISPLAY_PATH_PREFIX):
        relative = file_path[len(_DISPLAY_PATH_PREFIX):]
        return DATA_ROOT / relative
    return None


def _is_under(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _dedupe_paths(paths: Iterable[Path | None]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for path in paths:
        if path is None:
            continue
        resolved = Path(path).resolve()
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        result.append(resolved)
    return result


def _session_read_roots(session_id: str | None, run_id: str | None) -> list[Path]:
    if not session_id:
        return []
    roots = [
        get_session_sandbox_root(session_id),
        get_session_workspace_root(session_id),
        get_session_transient_root(session_id),
        get_session_uploads_root(session_id),
        get_session_visualizations_root(session_id),
        get_session_exports_root(session_id),
        get_session_root(session_id),
    ]
    if run_id:
        roots.insert(5, get_export_run_root(session_id, run_id))
    return _dedupe_paths(roots)


def _direct_write_roots(
    session_id: str | None,
    run_id: str | None,
    workspace_root: str | Path | None,
) -> list[Path]:
    explicit_workspace = Path(workspace_root).resolve() if workspace_root else None
    if session_id:
        roots = [
            explicit_workspace,
            get_session_workspace_root(session_id),
            get_session_transient_root(session_id),
            get_export_run_root(session_id, run_id) if run_id else get_session_exports_root(session_id),
        ]
        return _dedupe_paths(roots)
    if explicit_workspace is not None:
        return _dedupe_paths([explicit_workspace])
    return [_anonymous_session_root() / "transient"]


def _relative_candidate_roots(
    *,
    session_id: str | None,
    run_id: str | None,
    caller: str,
    operation: str,
    workspace_root: str | Path | None,
) -> list[Path]:
    explicit_workspace = Path(workspace_root).resolve() if workspace_root else None

    if caller == "code_execution":
        sandbox_root = get_session_sandbox_root(session_id) if session_id else _anonymous_session_root() / "sandbox"
        if operation in _WRITE_OPERATIONS:
            return [sandbox_root.resolve()]
        session_roots = _session_read_roots(session_id, run_id)
        return _dedupe_paths([
            sandbox_root,
            explicit_workspace,
            *session_roots,
        ])

    if operation in _WRITE_OPERATIONS:
        return _direct_write_roots(session_id, run_id, workspace_root)

    return _dedupe_paths([
        explicit_workspace,
        get_session_workspace_root(session_id) if session_id else None,
        *_session_read_roots(session_id, run_id),
        DATA_ROOT,
    ])


def _allowed_roots_for_access(
    *,
    session_id: str | None,
    run_id: str | None,
    caller: str,
    operation: str,
    workspace_root: str | Path | None,
) -> list[Path]:
    explicit_workspace = Path(workspace_root).resolve() if workspace_root else None

    if caller == "code_execution":
        if operation in _WRITE_OPERATIONS:
            sandbox_root = get_session_sandbox_root(session_id) if session_id else _anonymous_session_root() / "sandbox"
            return [sandbox_root.resolve()]
        return _dedupe_paths([
            explicit_workspace,
            get_session_sandbox_root(session_id) if session_id else _anonymous_session_root() / "sandbox",
            *_session_read_roots(session_id, run_id),
        ])

    if operation in _WRITE_OPERATIONS:
        return _direct_write_roots(session_id, run_id, workspace_root)

    return _dedupe_paths([
        explicit_workspace,
        *_session_read_roots(session_id, run_id),
        DATA_ROOT,
    ])


def _assert_allowed_path(
    path: Path,
    *,
    session_id: str | None,
    run_id: str | None,
    caller: str,
    operation: str,
    workspace_root: str | Path | None,
    original_path: str,
) -> Path:
    resolved = path.resolve()
    allowed_roots = _allowed_roots_for_access(
        session_id=session_id,
        run_id=run_id,
        caller=caller,
        operation=operation,
        workspace_root=workspace_root,
    )
    if any(_is_under(resolved, root) for root in allowed_roots):
        return resolved
    raise PermissionError(f"路径 '{original_path}' 超出允许的受管目录范围，禁止访问")


def _allocate_output_root(
    *,
    session_id: str | None,
    run_id: str | None,
    caller: str,
    default_output_space: str | None,
) -> Path:
    output_space = (default_output_space or "").strip().lower()

    if caller == "code_execution":
        if output_space == "exports":
            sid = _normalize_session_id(session_id, required=True, feature="exports 输出")
            rid = _normalize_run_id(run_id)
            if not rid:
                raise ValueError("exports 输出缺少 run_id")
            return get_export_run_root(sid, rid)
        if output_space == "workspace":
            sid = _normalize_session_id(session_id, required=True, feature="workspace 输出")
            return get_session_workspace_root(sid)
        if session_id:
            return get_session_transient_root(session_id)
        return _anonymous_session_root() / "transient"

    if output_space == "exports":
        sid = _normalize_session_id(session_id, required=True, feature="exports 输出")
        rid = _normalize_run_id(run_id)
        if not rid:
            raise ValueError("exports 输出缺少 run_id")
        return get_export_run_root(sid, rid)
    if output_space == "workspace":
        sid = _normalize_session_id(session_id, required=True, feature="workspace 输出")
        return get_session_workspace_root(sid)
    if session_id:
        return get_session_transient_root(session_id)
    return _anonymous_session_root() / "transient"


def resolve_managed_path(
    file_path: str | None = None,
    *,
    session_id: str | None = None,
    run_id: str | None = None,
    caller: str = "direct",
    operation: str = "read",
    default_output_space: str | None = None,
    workspace_root: str | Path | None = None,
    suffix: str = ".txt",
) -> Path:
    """
    将 direct / code_execution 的文件路径统一解析为受管绝对路径。

    规则：
    - direct 读取：优先 workspace/session 目录
    - code_execution 读取：相对路径优先 sandbox，其次当前 session 只读目录
    - code_execution 写入：仅允许当前 session 的 sandbox
    - write_file 未指定 file_path：根据 default_output_space 分配到 exports/workspace/transient
    - 所有绝对路径 / 展示路径都会做受管边界校验
    """
    op = (operation or "read").strip().lower()
    if op not in _VALID_OPERATIONS:
        raise ValueError(f"不支持的路径操作类型: {operation}")
    if caller not in {"direct", "code_execution"}:
        raise ValueError(f"不支持的调用来源: {caller}")

    normalized_session_id = _normalize_session_id(session_id)
    normalized_run_id = _normalize_run_id(run_id)

    if file_path is None or not str(file_path).strip():
        if op not in _WRITE_OPERATIONS:
            raise ValueError("读取操作必须提供 file_path")
        root = _allocate_output_root(
            session_id=normalized_session_id,
            run_id=normalized_run_id,
            caller=caller,
            default_output_space=default_output_space,
        )
        root.mkdir(parents=True, exist_ok=True)
        return (root / f"output_{uuid.uuid4().hex[:12]}{suffix}").resolve()

    raw_path = str(file_path).strip()
    display_mapped = _from_display_path(raw_path)
    if display_mapped is not None:
        return _assert_allowed_path(
            display_mapped,
            session_id=normalized_session_id,
            run_id=normalized_run_id,
            caller=caller,
            operation=op,
            workspace_root=workspace_root,
            original_path=raw_path,
        )

    original = Path(raw_path)
    if original.is_absolute():
        return _assert_allowed_path(
            original,
            session_id=normalized_session_id,
            run_id=normalized_run_id,
            caller=caller,
            operation=op,
            workspace_root=workspace_root,
            original_path=raw_path,
        )

    candidate_roots = _relative_candidate_roots(
        session_id=normalized_session_id,
        run_id=normalized_run_id,
        caller=caller,
        operation=op,
        workspace_root=workspace_root,
    )
    if not candidate_roots:
        raise PermissionError(f"路径 '{raw_path}' 缺少可用的受管根目录")

    if op in _READ_OPERATIONS:
        for root in candidate_roots:
            candidate = (root / original).resolve()
            if _is_under(candidate, root.resolve()) and candidate.exists():
                return _assert_allowed_path(
                    candidate,
                    session_id=normalized_session_id,
                    run_id=normalized_run_id,
                    caller=caller,
                    operation=op,
                    workspace_root=workspace_root,
                    original_path=raw_path,
                )

    fallback_candidate = (candidate_roots[0] / original).resolve()
    return _assert_allowed_path(
        fallback_candidate,
        session_id=normalized_session_id,
        run_id=normalized_run_id,
        caller=caller,
        operation=op,
        workspace_root=workspace_root,
        original_path=raw_path,
    )


def infer_resource_scope(path: str | Path) -> str:
    """根据物理路径推断资源 scope。"""
    resolved = Path(path).resolve()

    def _matches(root: Path) -> bool:
        return _is_under(resolved, root.resolve())

    if _matches(SESSIONS_ROOT):
        parts = resolved.relative_to(SESSIONS_ROOT.resolve()).parts
        if len(parts) >= 2:
            bucket = parts[1]
            if bucket == "uploads":
                return "upload"
            if bucket == "workspace":
                return "workspace"
            if bucket == "exports":
                return "export"
            if bucket in {"sandbox", "transient"}:
                return "transient"
            if bucket == "visualizations":
                return "session"
        return "session"

    if _matches(_LEGACY_VISUALIZATION_ROOT):
        return "session"
    if _matches(_LEGACY_EXPORTS_ROOT):
        return "export"
    if _matches(_LEGACY_WORKSPACE_ROOT):
        return "workspace"
    if _matches(_LEGACY_CODE_EXECUTION_ROOT) or _matches(_LEGACY_TRANSIENT_ROOT) or _matches(_LEGACY_TRANSIENT_ARTIFACTS_ROOT):
        return "transient"

    return "transient"


# ── 展示路径转换 ────────────────────────────────────────────────

def to_display_path(absolute_path: Path | str) -> str:
    p = Path(absolute_path).resolve()
    try:
        relative = p.relative_to(DATA_ROOT.resolve())
        return f"{_DISPLAY_PATH_PREFIX}{relative.as_posix()}"
    except ValueError:
        return p.as_posix()


# ── 启动时初始化 ────────────────────────────────────────────────

_ALL_DIRS = [
    DB_ROOT,
    MONITORING_ROOT,
    SESSION_TRACES_ROOT,
    SESSIONS_ROOT,
]


def ensure_directories() -> None:
    for directory in _ALL_DIRS:
        directory.mkdir(parents=True, exist_ok=True)
