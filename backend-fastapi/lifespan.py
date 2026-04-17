# -*- coding: utf-8 -*-
"""
FastAPI 应用生命周期管理。
"""

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI

logger = logging.getLogger(__name__)

_runtime_initialized = False


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """FastAPI 应用生命周期：启动 → 运行 → 关闭。"""
    logger.info('FastAPI 应用启动中...')

    await _startup(app)

    logger.info('FastAPI 应用已就绪')

    yield  # 应用运行中

    logger.info('FastAPI 应用关闭')
    await _shutdown(app)


async def _startup(app: FastAPI) -> None:
    """启动阶段：初始化运行时服务。"""
    global _runtime_initialized

    if _runtime_initialized:
        return

    # ── 第零步：初始化数据目录结构 ──────────────────────────────────────
    try:
        from core.path_resolution import ensure_directories
        ensure_directories()
        logger.debug('✓ 数据目录结构已初始化')
    except Exception as e:
        logger.warning('数据目录初始化失败: %s', e)

    # ── 第零·二步：探测旧版仓库内 data 目录 ─────────────────────────────
    try:
        _warn_legacy_repo_data_dir()
    except Exception as e:
        logger.warning('旧数据目录探测失败: %s', e)

    # ── 第零·三步：内置 Skill 复制到全局目录 ───────────────────────────
    try:
        from agents.skills.skill_bootstrap import bootstrap_builtin_skills
        copied = bootstrap_builtin_skills()
        if copied:
            logger.info('✓ 内置 Skill 已初始化: %s', ', '.join(copied))
        else:
            logger.debug('✓ 内置 Skill 已就绪')
    except Exception as e:
        logger.warning('内置 Skill 初始化失败（不影响核心功能）: %s', e)

    # ── 第零·五步：迁移配置文件到 CONFIG_ROOT ──────────────────────────
    try:
        _migrate_configs()
        logger.debug('✓ 配置文件位置已确认')
    except Exception as e:
        logger.warning('配置文件迁移失败: %s', e)

    # ── 第一步：初始化 RuntimeContainer（所有其他服务的前置依赖）──────────
    try:
        from runtime.container import create_runtime_container
        container = create_runtime_container()
        # 把 container 存到 app.state，方便后续访问
        app.state.runtime_container = container
        logger.debug('✓ RuntimeContainer 已初始化')
    except Exception as e:
        logger.error('✗ RuntimeContainer 初始化失败: %s', e, exc_info=True)
        raise  # 这是核心依赖，失败则终止启动

    # ── 第二步：运行健康检查 ────────────────────────────────────────────────
    try:
        from config.health_check import run_health_check
        if not run_health_check():
            logger.warning('健康检查未完全通过，但继续启动...')
        else:
            logger.debug('✓ 健康检查通过')
    except Exception as e:
        logger.warning('健康检查失败（不影响启动）: %s', e)

    # ── 第三步：初始化向量数据库 ────────────────────────────────────────────
    try:
        from vector_store.init_store import init_vector_store, is_vector_db_configured
        if is_vector_db_configured():
            success = init_vector_store()
            logger.debug('✓ 向量数据库初始化: %s', '成功' if success else '失败')
        else:
            logger.debug('向量数据库未配置，跳过初始化')
    except Exception as e:
        logger.warning('向量数据库初始化失败（不影响其他功能）: %s', e)

    # ── 第四步：初始化 Agent API 运行时 ────────────────────────────────────
    try:
        from services.agent_api_runtime_service import get_agent_api_runtime_service
        runtime = get_agent_api_runtime_service()
        logger.debug('✓ Agent API 运行时已初始化')
    except Exception as e:
        logger.warning('Agent API 运行时初始化失败: %s', e)

    # ── 第 4.1 步：绑定 SessionCache 到 ConversationStore ──────────────────
    try:
        from agents.context.session_cache import bind_store
        bind_store(runtime.get_conversation_store())
        logger.debug('✓ SessionCache 已绑定 ConversationStore')
    except Exception as e:
        logger.warning('SessionCache 绑定失败（不影响核心功能）: %s', e)

    # ── 第 4.5 步：统一 bootstrap 工具系统 ──────────────────────────────────
    try:
        from tools.runtime.bootstrap import bootstrap_tool_system

        bootstrap_result = bootstrap_tool_system()
        warnings = bootstrap_result.get('warnings', [])
        if warnings:
            logger.warning('工具一致性校验发现 %d 个问题', len(warnings))
        else:
            logger.debug('✓ 工具系统 bootstrap 完成')
    except Exception as e:
        logger.warning('工具系统 bootstrap 失败（不影响核心功能）: %s', e)

    # ── 第 4.6 步：bootstrap Hook 系统 ──────────────────────────────────────
    try:
        from hooks.bootstrap import bootstrap_hook_system

        bootstrap_hook_system()
        logger.debug('✓ Hook 系统 bootstrap 完成')
    except Exception as e:
        logger.warning('Hook 系统 bootstrap 失败（不影响核心功能）: %s', e)

    # ── 第 4.7 步：注册内建斜杠命令 ─────────────────────────────────────────
    try:
        import commands.builtin  # noqa: F401 — 触发内建命令注册
        logger.debug('✓ 内建斜杠命令已注册')
    except Exception as e:
        logger.warning('斜杠命令注册失败（不影响核心功能）: %s', e)

    # ── 第五步（新增）：加载外部扩展 ──────────────────────────────────────
    loaded_extensions = []
    try:
        from extensions.loader import discover_extensions
        loaded_extensions = discover_extensions()
        if loaded_extensions:
            # 5a. 注册扩展工具
            from tools.tool_registry import get_tool_registry
            for ext in loaded_extensions:
                get_tool_registry().register_contracts(ext.get_tool_contracts())

            # 5b. 注册扩展格式化器
            from agents.context.observation_formatters.registry import get_default_registry
            fmt_registry = get_default_registry()
            for ext in loaded_extensions:
                for fmt in ext.get_observation_formatters():
                    fmt_registry.register(fmt)

            # 5c. 注册扩展 Skills 目录
            from agents.skills.skill_loader import get_skill_loader
            for ext in loaded_extensions:
                for d in ext.get_skills_dirs():
                    get_skill_loader().add_skills_dir(d)

            # 5d. 挂载扩展 API 路由
            from api.v1 import router as v1_router
            for ext in loaded_extensions:
                for (router, prefix, tag) in ext.get_api_routers():
                    v1_router.include_router(router, prefix=prefix, tags=[tag])

            # 5e. 调用扩展 startup 钩子
            for ext in loaded_extensions:
                await ext.on_startup(container)

            logger.debug('✓ 加载 %d 个外部扩展', len(loaded_extensions))
    except Exception as e:
        logger.warning('扩展加载失败（不影响核心功能）: %s', e)

    app.state.loaded_extensions = loaded_extensions

    # ── 第六步：启动 MCP Client Manager ────────────────────────────────────
    try:
        container.startup_mcp()
        logger.debug('✓ MCP Client Manager 已启动')
    except Exception as e:
        logger.warning('MCP Client Manager 启动失败（不影响其他功能）: %s', e)

    # ── 第七步：启动守护 Agent 系统 ──────────────────────────────────────
    try:
        daemon_svc = container.get_daemon_service()
        await daemon_svc.start()
        if daemon_svc.config.enabled:
            logger.debug('✓ 守护 Agent 系统已启动')
        else:
            logger.debug('守护 Agent 系统未启用')
    except Exception as e:
        logger.warning('守护 Agent 系统启动失败（不影响核心功能）: %s', e)

    _runtime_initialized = True


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


def _seed_runtime_configs() -> None:
    """将源码目录中的部分运行时配置初始化到 CONFIG_ROOT。"""
    import shutil
    from core.path_resolution import CONFIG_ROOT, BACKEND_ROOT

    migrations = [
        (
            [
                BACKEND_ROOT / "agents" / "configs" / "agent_configs.yaml",
                BACKEND_ROOT / "agents" / "configs" / "agent_configs.yaml.example",
            ],
            CONFIG_ROOT / "agents" / "agent_configs.yaml",
            None,
        ),
        (
            [
                BACKEND_ROOT / "config" / "yaml" / "config.yaml",
                BACKEND_ROOT / "config" / "yaml" / "config.yaml.example",
            ],
            CONFIG_ROOT / "app" / "config.yaml",
            None,
        ),
    ]

    for sources, dst, inline_default in migrations:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            continue
        copied = False
        for src in sources:
            if src.exists():
                shutil.copy2(src, dst)
                logger.debug('配置文件已迁移: %s → %s', src.name, dst)
                copied = True
                break
        if not copied and inline_default is not None:
            dst.write_text(inline_default, encoding='utf-8')
            logger.debug('配置文件已初始化: %s', dst)


def _migrate_configs() -> None:
    """
    将源码目录中的部分运行时配置初始化到 CONFIG_ROOT。
    仅初始化 app / agent 配置；MCP 与 model provider 配置不再自动 seed。
    仅当目标不存在时执行拷贝，已存在则跳过（不覆盖用户修改）。
    """
    _seed_runtime_configs()


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
