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
    logger.info('=' * 70)
    logger.info('FastAPI 应用启动中...')
    logger.info('=' * 70)

    await _startup(app)

    logger.info('=' * 70)
    logger.info('FastAPI 应用已就绪')
    logger.info('=' * 70)

    yield  # 应用运行中

    logger.info('FastAPI 应用正在关闭...')
    await _shutdown(app)
    logger.info('FastAPI 应用已关闭')


async def _startup(app: FastAPI) -> None:
    """启动阶段：初始化运行时服务。"""
    global _runtime_initialized

    if _runtime_initialized:
        return

    # ── 第一步：初始化 RuntimeContainer（所有其他服务的前置依赖）──────────
    try:
        from runtime.container import create_runtime_container
        container = create_runtime_container()
        # 把 container 存到 app.state，方便后续访问
        app.state.runtime_container = container
        logger.info('✓ RuntimeContainer 已初始化')
    except Exception as e:
        logger.error('✗ RuntimeContainer 初始化失败: %s', e, exc_info=True)
        raise  # 这是核心依赖，失败则终止启动

    # ── 第二步：运行健康检查 ────────────────────────────────────────────────
    try:
        from config.health_check import run_health_check
        if not run_health_check():
            logger.warning('健康检查未完全通过，但继续启动...')
        else:
            logger.info('✓ 健康检查通过')
    except Exception as e:
        logger.warning('健康检查失败（不影响启动）: %s', e)

    # ── 第三步：初始化向量数据库 ────────────────────────────────────────────
    try:
        from vector_store.init_store import init_vector_store, is_vector_db_configured
        if is_vector_db_configured():
            success = init_vector_store()
            logger.info('✓ 向量数据库初始化: %s', '成功' if success else '失败')
        else:
            logger.info('向量数据库未配置，跳过初始化')
    except Exception as e:
        logger.warning('向量数据库初始化失败（不影响其他功能）: %s', e)

    # ── 第四步：初始化 Agent API 运行时 ────────────────────────────────────
    try:
        from services.agent_api_runtime_service import get_agent_api_runtime_service
        runtime = get_agent_api_runtime_service()
        logger.info('✓ Agent API 运行时已初始化')
    except Exception as e:
        logger.warning('Agent API 运行时初始化失败: %s', e)

    # ── 第五步（新增）：加载外部扩展 ──────────────────────────────────────
    loaded_extensions = []
    try:
        from extensions.loader import discover_extensions
        loaded_extensions = discover_extensions()
        if loaded_extensions:
            # 5a. 注册扩展工具
            from tools.tool_registry import get_tool_registry
            for ext in loaded_extensions:
                get_tool_registry().register_extra_contracts(ext.get_tool_contracts())

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

            logger.info('✓ 加载 %d 个外部扩展', len(loaded_extensions))
    except Exception as e:
        logger.warning('扩展加载失败（不影响核心功能）: %s', e)

    app.state.loaded_extensions = loaded_extensions

    # ── 第六步：启动 MCP Client Manager ────────────────────────────────────
    try:
        container.startup_mcp()
        logger.info('✓ MCP Client Manager 已启动')
    except Exception as e:
        logger.warning('MCP Client Manager 启动失败（不影响其他功能）: %s', e)

    _runtime_initialized = True


async def _shutdown(app: FastAPI) -> None:
    """关闭阶段：清理资源。"""
    container = getattr(app.state, 'runtime_container', None)
    if container is not None:
        try:
            container.shutdown()
            logger.info('RuntimeContainer 已关闭')
        except Exception as e:
            logger.warning('关闭 RuntimeContainer 失败: %s', e)

    for ext in getattr(app.state, 'loaded_extensions', []):
        try:
            await ext.on_shutdown(container)
        except Exception as e:
            logger.warning('扩展 %s.on_shutdown 失败: %s', ext.name, e)
