# -*- coding: utf-8 -*-
"""
系统配置 API 路由 - Schema-Driven 动态配置。
"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError

from schemas.common import ok

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_config_manager():
    from config import get_manager
    return get_manager()


def _refresh_runtime_after_config_change() -> list[str]:
    """刷新依赖系统配置的运行时缓存。"""
    warnings: list[str] = []

    try:
        from services.agent_api_runtime_service import get_agent_api_runtime_service
        runtime = get_agent_api_runtime_service()
        reload_agents = getattr(runtime, 'reload_agents', None)
        if callable(reload_agents) and not reload_agents():
            warnings.append('agent runtime reload failed')
    except Exception as e:
        warnings.append(f'agent runtime reload failed: {e}')

    try:
        from vector_store.client import reset_vector_client
        from vector_store.init_store import reset_vector_store_initialized
        reset_vector_client()
        reset_vector_store_initialized()
    except Exception as e:
        warnings.append(f'vector store reset failed: {e}')

    if warnings:
        logger.warning('系统配置已更新，但部分运行时刷新失败: %s', '; '.join(warnings))
    return warnings


@router.get('/schema')
async def get_system_config_schema():
    """返回 AppConfig 的 schema（供前端 SchemaForm 渲染）。"""
    try:
        from config.schema import generate_config_schema
        from config.models import AppConfig
        schema = generate_config_schema(AppConfig)
        return ok(data=schema, message='系统配置 schema')
    except Exception as e:
        logger.error('生成系统配置 schema 失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('')
async def get_system_config():
    """返回当前系统配置值。"""
    try:
        config_dict = await asyncio.to_thread(_get_config_manager().get_config_dict, redact_sensitive=True)
        return ok(data=config_dict, message='当前系统配置')
    except Exception as e:
        logger.error('获取系统配置失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch('')
async def update_system_config(request: Request):
    """部分更新系统配置。"""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail='请求体必须是 JSON object')
        manager = _get_config_manager()
        await asyncio.to_thread(manager.update_config, body)
        await asyncio.to_thread(_refresh_runtime_after_config_change)
        config_dict = await asyncio.to_thread(manager.get_config_dict, redact_sensitive=True)
        return ok(data=config_dict, message='系统配置已更新')
    except HTTPException:
        raise
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error('更新系统配置失败: %s', e, exc_info=True)
        raise HTTPException(status_code=400, detail=str(e))


@router.post('/reload')
async def reload_system_config():
    """从磁盘重新加载系统配置。"""
    try:
        await asyncio.to_thread(_get_config_manager().reload)
        await asyncio.to_thread(_refresh_runtime_after_config_change)
        return ok(message='系统配置已重新加载')
    except Exception as e:
        logger.error('重载系统配置失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
