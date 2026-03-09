# -*- coding: utf-8 -*-
"""
API v1 路由汇总。
"""

from fastapi import APIRouter

from .agents import router as agents_router
from .execution import router as execution_router
from .stream import router as stream_router
from .sessions import router as sessions_router
from .config import router as config_router
from .monitoring import router as monitoring_router
from .models import router as models_router
from .mcp import router as mcp_router
from .files import router as files_router
from .vector import router as vector_router
from .vector_management import router as vector_management_router
from .embedding_models import router as embedding_models_router

router = APIRouter()

# Agent 管理
router.include_router(agents_router, prefix='/agent', tags=['Agent 管理'])

# 执行 API（同步）
router.include_router(execution_router, prefix='/agent', tags=['Agent 执行'])

# 流式执行
router.include_router(stream_router, prefix='/agent', tags=['Agent 流式执行'])

# 会话管理
router.include_router(sessions_router, prefix='/agent', tags=['会话管理'])

# 监控
router.include_router(monitoring_router, prefix='/agent', tags=['监控'])

# Agent 配置管理
router.include_router(config_router, prefix='/agent-config', tags=['Agent 配置'])

# 模型适配器
router.include_router(models_router, prefix='/model-adapter', tags=['模型适配器'])

# MCP 管理
router.include_router(mcp_router, prefix='/mcp', tags=['MCP 管理'])

# 文件管理
router.include_router(files_router, prefix='/files', tags=['文件管理'])

# 向量库管理
router.include_router(vector_router, prefix='/vector-library', tags=['向量库'])

# 向量数据管理
router.include_router(vector_management_router, prefix='/vector', tags=['向量管理'])

# Embedding 模型管理
router.include_router(embedding_models_router, prefix='/embedding-models', tags=['Embedding 模型'])
