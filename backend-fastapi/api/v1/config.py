# -*- coding: utf-8 -*-
"""
Agent 配置管理 API 路由。
"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query, Request
from typing import Any, Dict, Optional

from schemas.common import ok

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_service():
    from dependencies import get_agent_config_service
    return get_agent_config_service()


@router.get('/configs')
async def list_configs():
    """列出所有智能体配置。"""
    try:
        configs = await asyncio.to_thread(_get_service().list_configs)
        return ok(data=configs, message=f'共有 {len(configs)} 个智能体配置')
    except Exception as e:
        logger.error('获取配置列表失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/configs/{agent_name}')
async def get_config(agent_name: str):
    """获取指定智能体配置。"""
    try:
        from services.agent_config_service import AgentConfigServiceError
        config = await asyncio.to_thread(_get_service().get_config, agent_name)
        return ok(data=config, message=f'智能体 "{agent_name}" 配置')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('获取配置失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.put('/configs/{agent_name}')
async def update_config(agent_name: str, request: Request):
    """更新智能体配置（完整更新）。"""
    try:
        body = await request.json()
        config = await asyncio.to_thread(_get_service().replace_config, agent_name, body)
        return ok(data=config, message=f'智能体 "{agent_name}" 配置已更新')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('更新配置失败: %s', e, exc_info=True)
        raise HTTPException(status_code=400, detail=str(e))


@router.patch('/configs/{agent_name}')
async def patch_config(agent_name: str, request: Request):
    """更新智能体配置（部分更新）。"""
    try:
        body = await request.json()
        config = await asyncio.to_thread(_get_service().patch_config, agent_name, body)
        return ok(data=config, message=f'智能体 "{agent_name}" 配置已更新')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('更新配置失败: %s', e, exc_info=True)
        raise HTTPException(status_code=400, detail=str(e))


@router.delete('/configs/{agent_name}')
async def delete_config(agent_name: str):
    """删除智能体配置。"""
    try:
        await asyncio.to_thread(_get_service().delete_config, agent_name)
        return ok(message=f'智能体 "{agent_name}" 配置已删除')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('删除配置失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/configs/{agent_name}/preset')
async def apply_preset(agent_name: str, request: Request):
    """应用预设配置。"""
    try:
        payload = await request.json()
        config = await asyncio.to_thread(
            _get_service().apply_preset, agent_name, payload.get('preset')
        )
        return ok(data=config, message=f'已应用预设 "{payload.get("preset")}"')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('应用预设失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/configs/{agent_name}/export')
async def export_config(
    agent_name: str,
    format: str = Query('yaml'),
):
    """导出智能体配置。"""
    try:
        from fastapi.responses import Response
        result = await asyncio.to_thread(_get_service().export_config, agent_name, format_name=format)
        return Response(
            content=result['content'],
            media_type=result['content_type'],
        )
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('导出配置失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/configs/{agent_name}/import')
async def import_config(agent_name: str, request: Request):
    """导入智能体配置。"""
    try:
        body = await request.body()
        config = await asyncio.to_thread(
            _get_service().import_config,
            body.decode('utf-8'),
            format_name=request.query_params.get('format'),
            content_type=request.headers.get('content-type', ''),
        )
        return ok(data=config, message=f'智能体 "{config["agent_name"]}" 配置已导入')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('导入配置失败: %s', e, exc_info=True)
        raise HTTPException(status_code=400, detail=str(e))


@router.get('/configs/{agent_name}/validate')
async def validate_config(agent_name: str):
    """验证智能体配置。"""
    try:
        result = await asyncio.to_thread(_get_service().validate_config, agent_name)
        return ok(data=result, message='验证完成')
    except Exception as e:
        logger.error('验证配置失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/presets')
async def list_presets():
    """列出所有可用预设。"""
    try:
        presets = await asyncio.to_thread(_get_service().list_presets)
        return ok(data=presets, message=f'共有 {len(presets)} 个预设')
    except Exception as e:
        logger.error('获取预设列表失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/tools')
async def list_available_tools():
    """列出所有可用工具。"""
    try:
        tools = await asyncio.to_thread(_get_service().list_available_tools)
        return ok(data=tools, message=f'共有 {len(tools)} 个可用工具')
    except Exception as e:
        logger.error('获取工具列表失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/mcp-servers')
async def list_available_mcp_servers():
    """列出可分配给智能体的 MCP Server。"""
    try:
        servers = await asyncio.to_thread(_get_service().list_available_mcp_servers)
        return ok(data=servers, message=f'Found {len(servers)} MCP servers')
    except Exception as e:
        logger.error('Failed to load MCP servers: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/skills')
async def list_available_skills():
    """列出所有可用 Skills。"""
    try:
        skills = await asyncio.to_thread(_get_service().list_available_skills)
        return ok(data=skills, message=f'共有 {len(skills)} 个可用 Skill')
    except Exception as e:
        logger.error('获取 Skills 列表失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
