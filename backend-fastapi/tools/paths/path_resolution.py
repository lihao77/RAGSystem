# -*- coding: utf-8 -*-
"""
兼容垫片：tools.paths.path_resolution → core.path_resolution

此文件已迁移到 core/path_resolution.py，此处仅做转发。
请将 import 改为：from core.path_resolution import ...
"""
import warnings
warnings.warn(
    "tools.paths.path_resolution 已迁移到 core.path_resolution，请更新 import。",
    DeprecationWarning,
    stacklevel=2,
)
from core.path_resolution import *  # noqa: F401, F403
from core.path_resolution import (
    BACKEND_ROOT, DATA_ROOT,
    DB_ROOT, MEMORY_ROOT, MONITORING_ROOT, SESSIONS_ROOT, UPLOADS_ROOT, CONFIG_ROOT,
    SESSION_TRACES_ROOT, RAGSYSTEM_DB, CHECKPOINTS_DB,
    get_session_root, get_session_sandbox_root, get_session_workspace_root,
    get_effective_workspace_root, get_workspace_memory_key,
    get_session_transient_root,
    get_session_uploads_root, get_uploads_root,
    get_session_visualizations_root, get_session_exports_root,
    get_export_run_root, get_session_cleanup_root,
    get_session_memory_scope_root, get_team_memory_scope_root,
    get_team_agent_memory_scope_root, get_workspace_memory_scope_root,
    resolve_managed_path, resolve_managed_directory,
    infer_resource_scope, to_display_path, ensure_directories,
)
