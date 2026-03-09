# -*- coding: utf-8 -*-
"""
MCP 管理 API 路由。
"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request, Query
from typing import Optional

from schemas.common import ok

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_capability():
    from dependencies import get_mcp_tools_capability
    return get_mcp_tools_capability()


def _get_request_id(request: Request) -> str:
    from dependencies import get_agent_runtime_service
    try:
        from execution.observability import ensure_request_id
        return ensure_request_id(request.headers.get('X-Request-ID'))
    except Exception:
        import uuid
        return str(uuid.uuid4())[:8]


@router.get('/templates')
async def list_server_templates():
    """列出可安装的 MCP Server 模板。"""
    data = await asyncio.to_thread(_get_capability().list_templates)
    return ok(data=data)


@router.post('/templates/install')
async def install_server_from_template(request: Request):
    """从模板安装 MCP Server 配置。"""
    try:
        body = await request.json()
        data = await asyncio.to_thread(_get_capability().install_server_from_template, body)
        return ok(data=data, message='MCP Server installed from template')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/registry/servers')
async def search_registry(
    search: str = Query(''),
    cursor: Optional[str] = Query(None),
    limit: int = Query(8, ge=1, le=50),
    latest_only: str = Query('true'),
):
    """搜索官方 MCP Registry。"""
    try:
        is_latest_only = latest_only.strip().lower() not in {'0', 'false', 'no', 'off'}
        result = await asyncio.to_thread(
            _get_capability().search_registry,
            search=search, cursor=cursor, limit=limit, latest_only=is_latest_only,
        )
        return ok(data=result, message=f'Found {result.get("count", 0)} MCP Registry servers')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/registry/install')
async def install_server_from_registry(request: Request):
    """从 Registry 安装 MCP Server。"""
    try:
        body = await request.json()
        data = await asyncio.to_thread(_get_capability().install_server_from_registry, body)
        return ok(data=data, message='MCP Server installed from Registry')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/servers')
async def list_servers():
    """列出所有 MCP Server 及连接状态。"""
    data = await asyncio.to_thread(_get_capability().list_servers)
    return ok(data=data)


@router.post('/servers')
async def add_server(request: Request):
    """添加 MCP Server 配置。"""
    try:
        body = await request.json()
        request_id = _get_request_id(request)
        data = await asyncio.to_thread(_get_capability().add_server, body, request_id=request_id)
        return ok(data=data, message='MCP Server 添加成功')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        raise HTTPException(status_code=500, detail=str(e))


@router.put('/servers/{server_name}')
async def update_server(server_name: str, request: Request):
    """更新 MCP Server 配置。"""
    try:
        body = await request.json()
        request_id = _get_request_id(request)
        status = await asyncio.to_thread(
            _get_capability().update_server, server_name, body, request_id=request_id
        )
        message = 'MCP Server configuration updated and applied'
        if status.get('status') == 'error':
            message = 'MCP Server configuration updated, but reconnect failed'
        return ok(data=status, message=message)
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete('/servers/{server_name}')
async def delete_server(server_name: str, request: Request):
    """删除 MCP Server 配置。"""
    try:
        request_id = _get_request_id(request)
        await asyncio.to_thread(_get_capability().delete_server, server_name, request_id=request_id)
        return ok(message='MCP Server 已删除')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/servers/{server_name}/connect')
async def connect_server(server_name: str, request: Request):
    """连接到指定 MCP Server。"""
    try:
        request_id = _get_request_id(request)
        status = await asyncio.to_thread(
            _get_capability().connect_server, server_name, request_id=request_id
        )
        return ok(data=status, message='连接成功')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/servers/{server_name}/disconnect')
async def disconnect_server(server_name: str, request: Request):
    """断开指定 MCP Server。"""
    request_id = _get_request_id(request)
    await asyncio.to_thread(_get_capability().disconnect_server, server_name, request_id=request_id)
    return ok(message='已断开连接')


@router.post('/servers/{server_name}/test')
async def test_server(server_name: str, request: Request):
    """测试连接（断开并重连）。"""
    try:
        request_id = _get_request_id(request)
        result = await asyncio.to_thread(
            _get_capability().test_server, server_name, request_id=request_id
        )
        return ok(data=result, message=result.get('message', ''))
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/servers/{server_name}/tools')
async def list_server_tools(server_name: str):
    """列出指定 MCP Server 提供的工具（OpenAI 格式）。"""
    data = await asyncio.to_thread(_get_capability().list_server_tools, server_name)
    return ok(data=data)


@router.get('/tools')
async def list_all_tools():
    """列出所有已连接 MCP Server 的工具。"""
    data = await asyncio.to_thread(_get_capability().list_all_tools)
    return ok(data=data)
