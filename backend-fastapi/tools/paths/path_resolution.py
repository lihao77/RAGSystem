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
BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_ROOT: Path = Path(os.environ.get("RAG_DATA_ROOT", str(BACKEND_ROOT / "data")))

# ── 一级目录常量 ────────────────────────────────────────────────
DB_ROOT: Path = DATA_ROOT / "db"
MEMORY_ROOT: Path = DATA_ROOT / "memory"
MONITORING_ROOT: Path = DATA_ROOT / "monitoring"
SESSIONS_ROOT: Path = DATA_ROOT / "sessions"
UPLOADS_ROOT: Path = DATA_ROOT / "uploads"

# ── 监控/数据库路径常量 ─────────────────────────────────────────
SESSION_TRACES_ROOT: Path = MONITORING_ROOT / "session_traces"
RAGSYSTEM_DB: Path = DB_ROOT / "ragsystem.db"
CHECKPOINTS_DB: Path = DB_ROOT / "checkpoints.db"

# ── 匿名 session 兜底 ─────────────────────────────────────────────
_DISPLAY_PATH_PREFIX = "./data/"
_ANONYMOUS_SESSION_ID = "anonymous"
_READ_OPERATIONS = {"read"}
_WRITE_OPERATIONS = {"write", "edit", "output"}
_VALID_OPERATIONS = _READ_OPERATIONS | _WRITE_OPERATIONS
_VALID_EXPLICIT_SPACES = {"workspace", "transient", "exports"}


def _normalize_explicit_space(explicit_space: str | None) -> str | None:
    value = (explicit_space or "").strip().lower()
    if not value:
        return None
    if value not in _VALID_EXPLICIT_SPACES:
        raise ValueError(f"不支持的显式空间: {explicit_space}")
    return value


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



# ── Session 级路径生成函数 ──────────────────────────────────────

def get_session_root(session_id: str) -> Path:
    return SESSIONS_ROOT / _normalize_session_id(session_id, required=True, feature="session 根目录")


def get_session_sandbox_root(session_id: str) -> Path:
    return get_session_root(session_id) / "sandbox"


def get_session_workspace_root(session_id: str) -> Path:
    return get_session_root(session_id) / "workspace"


def get_effective_workspace_root(
    session_id: str | None,
    workspace_root: str | Path | None = None,
) -> Path | None:
    explicit_workspace = Path(workspace_root).resolve() if workspace_root else None
    if explicit_workspace is not None:
        return explicit_workspace
    if session_id:
        return get_session_workspace_root(session_id)
    return None


def get_session_transient_root(session_id: str) -> Path:
    return get_session_root(session_id) / "transient"


def get_session_uploads_root(session_id: str) -> Path:
    return get_session_root(session_id) / "uploads"


def get_uploads_root() -> Path:
    return UPLOADS_ROOT


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


def get_memory_project_root(project_key: str) -> Path:
    normalized = (project_key or "").strip()
    if not normalized:
        raise ValueError("memory project root 缺少 project_key")
    return MEMORY_ROOT / "projects" / normalized


def get_project_memory_scope_root(project_key: str) -> Path:
    return get_memory_project_root(project_key) / "project"


def get_session_memory_scope_root(session_id: str, project_key: str) -> Path:
    normalized_session_id = _normalize_session_id(session_id, required=True, feature="memory session 目录")
    return get_memory_project_root(project_key) / "sessions" / normalized_session_id


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


def _session_read_roots(session_id: str | None, run_id: str | None, workspace_root: str | Path | None = None) -> list[Path]:
    if not session_id:
        return []
    effective_workspace = get_effective_workspace_root(session_id, workspace_root)
    roots = [
        get_session_sandbox_root(session_id),
        effective_workspace,
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
    effective_workspace = get_effective_workspace_root(session_id, workspace_root)
    if session_id:
        roots = [
            effective_workspace,
            get_session_transient_root(session_id),
            get_export_run_root(session_id, run_id) if run_id else get_session_exports_root(session_id),
        ]
        return _dedupe_paths(roots)
    if effective_workspace is not None:
        return _dedupe_paths([effective_workspace])
    return [_anonymous_session_root() / "transient"]


def _relative_candidate_roots(
    *,
    session_id: str | None,
    run_id: str | None,
    caller: str,
    operation: str,
    workspace_root: str | Path | None,
) -> list[Path]:
    effective_workspace = get_effective_workspace_root(session_id, workspace_root)

    if caller == "code_execution":
        sandbox_root = get_session_sandbox_root(session_id) if session_id else _anonymous_session_root() / "sandbox"
        if operation in _WRITE_OPERATIONS:
            return _dedupe_paths([
                sandbox_root,
                *_session_read_roots(session_id, run_id, workspace_root),
            ])
        session_roots = _session_read_roots(session_id, run_id, workspace_root)
        return _dedupe_paths([
            sandbox_root,
            effective_workspace,
            *session_roots,
        ])

    if operation in _WRITE_OPERATIONS:
        return _direct_write_roots(session_id, run_id, workspace_root)

    return _dedupe_paths([
        effective_workspace,
        *_session_read_roots(session_id, run_id, workspace_root),
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
    effective_workspace = get_effective_workspace_root(session_id, workspace_root)

    if caller == "code_execution":
        if operation in _WRITE_OPERATIONS:
            return _dedupe_paths([
                get_session_sandbox_root(session_id) if session_id else _anonymous_session_root() / "sandbox",
                *_session_read_roots(session_id, run_id, workspace_root),
            ])
        return _dedupe_paths([
            effective_workspace,
            get_session_sandbox_root(session_id) if session_id else _anonymous_session_root() / "sandbox",
            *_session_read_roots(session_id, run_id, workspace_root),
        ])

    if operation in _WRITE_OPERATIONS:
        return _direct_write_roots(session_id, run_id, workspace_root)

    return _dedupe_paths([
        effective_workspace,
        *_session_read_roots(session_id, run_id, workspace_root),
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
    allowed_root_strings = [str(root.resolve()) for root in allowed_roots]
    allowed = any(_is_under(resolved, root) for root in allowed_roots)
    logger.debug(
        '受管路径边界校验: original_path=%s resolved_path=%s caller=%s operation=%s session_id=%s run_id=%s workspace_root=%s allowed=%s allowed_roots=%s',
        original_path,
        resolved,
        caller,
        operation,
        session_id,
        run_id,
        str(Path(workspace_root).resolve()) if workspace_root else None,
        allowed,
        allowed_root_strings,
    )
    if allowed:
        return resolved
    raise PermissionError(f"路径 '{original_path}' 超出允许的受管目录范围，禁止访问")


def _managed_space_root(
    *,
    space: str,
    session_id: str | None,
    run_id: str | None,
    workspace_root: str | Path | None,
) -> Path:
    if space == "workspace":
        root = get_effective_workspace_root(session_id, workspace_root)
        if root is None:
            raise ValueError("workspace 路径缺少可用目录")
        return root.resolve()
    if space == "transient":
        sid = _normalize_session_id(session_id, required=True, feature="transient 路径")
        return get_session_transient_root(sid).resolve()
    if space == "exports":
        sid = _normalize_session_id(session_id, required=True, feature="exports 路径")
        rid = _normalize_run_id(run_id)
        if not rid:
            raise ValueError("exports 路径缺少 run_id")
        return get_export_run_root(sid, rid).resolve()
    raise ValueError(f"不支持的显式空间: {space}")


def _explicit_space_root(
    *,
    explicit_space: str,
    session_id: str | None,
    run_id: str | None,
    workspace_root: str | Path | None,
) -> Path:
    return _managed_space_root(
        space=explicit_space,
        session_id=session_id,
        run_id=run_id,
        workspace_root=workspace_root,
    )



def _allocate_output_root(
    *,
    session_id: str | None,
    run_id: str | None,
    caller: str,
    default_output_space: str | None,
    workspace_root: str | Path | None = None,
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
            root = get_effective_workspace_root(sid, workspace_root)
            if root is None:
                raise ValueError("workspace 输出缺少可用目录")
            return root
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
        root = get_effective_workspace_root(sid, workspace_root)
        if root is None:
            raise ValueError("workspace 输出缺少可用目录")
        return root
    if session_id:
        return get_session_transient_root(session_id)
    return _anonymous_session_root() / "transient"
def _ensure_managed_directory_root(
    *,
    raw_directory: str,
    explicit_space: str | None,
    default_space: str,
    session_id: str | None,
    run_id: str | None,
    workspace_root: str | Path | None,
) -> None:
    if raw_directory not in {"", "."}:
        return

    target_space = explicit_space or default_space
    root = _managed_space_root(
        space=target_space,
        session_id=session_id,
        run_id=run_id,
        workspace_root=workspace_root,
    )
    root.mkdir(parents=True, exist_ok=True)



def resolve_managed_directory(
    directory: str | None = None,
    *,
    session_id: str | None = None,
    run_id: str | None = None,
    caller: str = "direct",
    workspace_root: str | Path | None = None,
    explicit_space: str | None = None,
    default_space: str = "workspace",
) -> Path:
    """
    将相对/绝对目录统一解析为受管绝对目录。

    规则：
    - directory 为空：返回 default_space 对应根目录
    - 绝对路径：仅做受管边界校验
    - 相对路径 + explicit_space：按对应受管目录桶解析
    - 相对路径 + 无 explicit_space：按 default_space 解析
    """
    if caller != "direct":
        raise ValueError(f"目录解析暂不支持的调用来源: {caller}")

    normalized_session_id = _normalize_session_id(session_id)
    normalized_run_id = _normalize_run_id(run_id)
    normalized_explicit_space = _normalize_explicit_space(explicit_space)
    normalized_default_space = _normalize_explicit_space(default_space)
    if normalized_default_space is None:
        raise ValueError("default_space 不能为空")

    raw_directory = str(directory).strip() if directory is not None else ""
    _ensure_managed_directory_root(
        raw_directory=raw_directory,
        explicit_space=normalized_explicit_space,
        default_space=normalized_default_space,
        session_id=normalized_session_id,
        run_id=normalized_run_id,
        workspace_root=workspace_root,
    )
    if not raw_directory:
        return _managed_space_root(
            space=normalized_explicit_space or normalized_default_space,
            session_id=normalized_session_id,
            run_id=normalized_run_id,
            workspace_root=workspace_root,
        )

    display_mapped = _from_display_path(raw_directory)
    if display_mapped is not None:
        return _assert_allowed_path(
            display_mapped,
            session_id=normalized_session_id,
            run_id=normalized_run_id,
            caller=caller,
            operation="read",
            workspace_root=workspace_root,
            original_path=raw_directory,
        )

    original = Path(raw_directory)
    if original.is_absolute():
        return _assert_allowed_path(
            original,
            session_id=normalized_session_id,
            run_id=normalized_run_id,
            caller=caller,
            operation="read",
            workspace_root=workspace_root,
            original_path=raw_directory,
        )

    base_root = _managed_space_root(
        space=normalized_explicit_space or normalized_default_space,
        session_id=normalized_session_id,
        run_id=normalized_run_id,
        workspace_root=workspace_root,
    )
    candidate = (base_root / original).resolve()
    return _assert_allowed_path(
        candidate,
        session_id=normalized_session_id,
        run_id=normalized_run_id,
        caller=caller,
        operation="read",
        workspace_root=workspace_root,
        original_path=raw_directory,
    )


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
    explicit_space: str | None = None,
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
    normalized_explicit_space = _normalize_explicit_space(explicit_space)

    if file_path is None or not str(file_path).strip():
        if op not in _WRITE_OPERATIONS:
            raise ValueError("读取操作必须提供 file_path")
        root = _allocate_output_root(
            session_id=normalized_session_id,
            run_id=normalized_run_id,
            caller=caller,
            default_output_space=default_output_space,
            workspace_root=workspace_root,
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

    if normalized_explicit_space is not None:
        explicit_root = _explicit_space_root(
            explicit_space=normalized_explicit_space,
            session_id=normalized_session_id,
            run_id=normalized_run_id,
            workspace_root=workspace_root,
        )
        explicit_candidate = (explicit_root / original).resolve()
        return _assert_allowed_path(
            explicit_candidate,
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


def infer_resource_scope(path: str | Path, *, workspace_root: str | Path | None = None) -> str:
    """根据物理路径推断资源 scope。"""
    resolved = Path(path).resolve()
    effective_workspace = Path(workspace_root).resolve() if workspace_root else None

    def _matches(root: Path | None) -> bool:
        return root is not None and _is_under(resolved, root.resolve())

    if _matches(effective_workspace):
        return "workspace"

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
    MEMORY_ROOT,
    MONITORING_ROOT,
    SESSION_TRACES_ROOT,
    SESSIONS_ROOT,
]


def ensure_directories() -> None:
    for directory in _ALL_DIRS:
        directory.mkdir(parents=True, exist_ok=True)
