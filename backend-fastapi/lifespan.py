# -*- coding: utf-8 -*-
"""
FastAPI 应用生命周期管理。

启动分三个阶段：
  Phase 1 — 文件系统准备（目录、配置 seed、Skill 复制）
  Phase 2 — 核心运行时（RuntimeContainer，失败终止启动）
  Phase 3 — 子系统（健康检查、向量库、工具/Hook/扩展/MCP/守护，各自独立）
"""

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Callable, TypeVar

from fastapi import FastAPI

logger = logging.getLogger(__name__)

_runtime_initialized = False

T = TypeVar('T')


# ── 辅助 ──────────────────────────────────────────────────────────


def _safe(fn: Callable[[], T], label: str) -> T | None:
    """执行 *fn*，失败仅警告不终止启动。"""
    try:
        result = fn()
        logger.debug('✓ %s', label)
        return result
    except Exception as e:
        logger.warning('%s 失败: %s', label, e)
        return None


async def _safe_async(fn, label: str):
    """异步版 _safe。"""
    try:
        result = await fn()
        logger.debug('✓ %s', label)
        return result
    except Exception as e:
        logger.warning('%s 失败: %s', label, e)
        return None


# ── 生命周期入口 ──────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """FastAPI 应用生命周期：启动 → 运行 → 关闭。"""
    logger.info('FastAPI 应用启动中...')

    await _startup(app)

    logger.info('FastAPI 应用已就绪')

    yield  # 应用运行中

    logger.info('FastAPI 应用关闭')
    await _shutdown(app)


# ── 启动 ──────────────────────────────────────────────────────────


async def _startup(app: FastAPI) -> None:
    """启动阶段：按 Phase 1→2→3 初始化运行时服务。"""
    global _runtime_initialized

    if _runtime_initialized:
        return

    # ── Phase 1: 文件系统准备（无外部依赖） ──
    _bootstrap_filesystem()

    # ── Phase 2: 核心运行时（失败终止启动） ──
    container = _bootstrap_core_runtime(app)

    # ── Phase 3: 子系统（各自独立，失败仅警告） ──
    await _bootstrap_subsystems(app, container)

    _runtime_initialized = True


def _bootstrap_filesystem() -> None:
    """Phase 1: 创建目录、检测旧目录、seed 配置文件、复制内置 Skill。

    ensure_directories 是硬依赖，失败直接终止；其余步骤失败仅警告。
    """
    from core.path_resolution import ensure_directories
    ensure_directories()

    _safe(_warn_legacy_repo_data_dir, '旧数据目录探测')

    def _seed_configs():
        from core.path_resolution import BACKEND_ROOT, CONFIG_ROOT
        from config.runtime_files import build_runtime_config_init_specs, seed_runtime_config_files

        specs = build_runtime_config_init_specs(config_root=CONFIG_ROOT, backend_root=BACKEND_ROOT)
        for src, dst in seed_runtime_config_files(specs):
            logger.debug('配置文件已迁移: %s → %s', src.name, dst)

    _safe(_seed_configs, '配置文件 seed')

    def _init_skills():
        from agents.skills.skill_bootstrap import bootstrap_builtin_skills
        copied = bootstrap_builtin_skills()
        if copied:
            logger.info('✓ 内置 Skill 已初始化: %s', ', '.join(copied))

    _safe(_init_skills, '内置 Skill')


def _bootstrap_core_runtime(app: FastAPI):
    """Phase 2: 初始化 RuntimeContainer，失败终止启动。"""
    from runtime.container import create_runtime_container

    try:
        container = create_runtime_container()
    except Exception as e:
        logger.error('✗ RuntimeContainer 初始化失败: %s', e, exc_info=True)
        raise

    app.state.runtime_container = container
    logger.debug('✓ RuntimeContainer 已初始化')
    return container


async def _bootstrap_subsystems(app: FastAPI, container) -> None:
    """Phase 3: 启动各子系统，每个子系统失败仅警告不终止。"""

    def _health_check():
        from config.health_check import run_health_check
        if not run_health_check():
            logger.warning('健康检查未完全通过，但继续启动...')

    def _vector_store():
        from vector_store.init_store import init_vector_store, is_vector_db_configured
        if is_vector_db_configured():
            init_vector_store()
        else:
            logger.debug('向量数据库未配置，跳过初始化')

    def _agent_runtime():
        from services.agent_api_runtime_service import get_agent_api_runtime_service
        from agents.context.session_cache import bind_store
        runtime = get_agent_api_runtime_service()
        bind_store(runtime.get_conversation_store())

    def _tools():
        from tools.runtime.bootstrap import bootstrap_tool_system
        result = bootstrap_tool_system()
        warnings = result.get('warnings', [])
        if warnings:
            logger.warning('工具一致性校验发现 %d 个问题', len(warnings))

    def _hooks():
        from hooks.bootstrap import bootstrap_hook_system
        bootstrap_hook_system()

    def _commands():
        import commands.builtin  # noqa: F401

    def _extensions():
        from extensions.loader import discover_extensions
        loaded = discover_extensions()
        if not loaded:
            return loaded

        from tools.tool_registry import get_tool_registry
        from agents.context.observation_formatters.registry import get_default_registry
        from agents.skills.skill_loader import get_skill_loader
        from api.v1 import router as v1_router

        for ext in loaded:
            get_tool_registry().register_contracts(ext.get_tool_contracts())
            for fmt in ext.get_observation_formatters():
                get_default_registry().register(fmt)
            for d in ext.get_skills_dirs():
                get_skill_loader().add_skills_dir(d)
            for (router, prefix, tag) in ext.get_api_routers():
                v1_router.include_router(router, prefix=prefix, tags=[tag])

        return loaded

    def _mcp():
        container.startup_mcp()

    async def _daemon():
        daemon_svc = container.get_daemon_service()
        await daemon_svc.start()
        if daemon_svc.config.enabled:
            logger.debug('✓ 守护 Agent 系统已启动')
        else:
            logger.debug('守护 Agent 系统未启用')

    _safe(_health_check, '健康检查')
    _safe(_vector_store, '向量数据库')
    _safe(_agent_runtime, 'Agent API 运行时')
    _safe(_tools, '工具系统')
    _safe(_hooks, 'Hook 系统')
    _safe(_commands, '斜杠命令')

    loaded_extensions = _safe(_extensions, '扩展加载') or []
    for ext in loaded_extensions:
        await _safe_async(lambda e=ext: e.on_startup(container), f'扩展 {ext.name}.on_startup')
    app.state.loaded_extensions = loaded_extensions

    _safe(_mcp, 'MCP')
    await _safe_async(_daemon, '守护系统')


# ── 关闭 ──────────────────────────────────────────────────────────


async def _shutdown(app: FastAPI) -> None:
    """关闭阶段：清理资源。"""
    container = getattr(app.state, 'runtime_container', None)

    # 守护 Agent 系统需要在 async 上下文中关闭，先于 container.shutdown() 执行
    if container is not None:
        daemon_svc = container._instances.get('daemon_service')
        if daemon_svc is not None and getattr(daemon_svc, '_running', False):
            try:
                await daemon_svc.stop()
                logger.debug('守护 Agent 系统已停止')
            except Exception as e:
                logger.warning('停止守护 Agent 系统失败: %s', e)

    if container is not None:
        try:
            container.shutdown()
            logger.debug('RuntimeContainer 已关闭')
        except Exception as e:
            logger.warning('关闭 RuntimeContainer 失败: %s', e)

    for ext in getattr(app.state, 'loaded_extensions', []):
        try:
            await ext.on_shutdown(container)
        except Exception as e:
            logger.warning('扩展 %s.on_shutdown 失败: %s', ext.name, e)


# ── 辅助：旧目录检测 ─────────────────────────────────────────────


def _warn_legacy_repo_data_dir() -> None:
    """检测仓库内旧 data 目录并给出迁移提示。"""
    from core.path_resolution import BACKEND_ROOT, DATA_ROOT

    legacy_data_root = BACKEND_ROOT / 'data'
    current_data_root = DATA_ROOT.resolve()
    if legacy_data_root.resolve() == current_data_root:
        return
    if not legacy_data_root.exists():
        return
    try:
        has_legacy_content = any(legacy_data_root.iterdir())
    except OSError:
        return
    if not has_legacy_content:
        return

    logger.warning(
        '检测到旧版仓库内数据目录仍存在: %s；当前默认数据根为: %s。'
        ' 配置文件会迁移到新的 config 根，但 db/memory/uploads/sessions/monitoring 不会自动迁移。'
        ' 如需沿用旧数据，请手动迁移或显式设置 RAG_DATA_ROOT。',
        legacy_data_root,
        current_data_root,
    )
