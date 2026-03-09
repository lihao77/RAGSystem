# -*- coding: utf-8 -*-
"""
模型适配器 API 路由。
"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request

from schemas.common import ok

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_service():
    from dependencies import get_model_adapter_service
    return get_model_adapter_service()


@router.get('/providers')
async def get_providers():
    """获取所有 Provider 列表。"""
    try:
        providers = await asyncio.to_thread(_get_service().list_providers)
        return {**ok(data=providers, message='Provider 列表获取成功'), 'providers': providers}
    except Exception as e:
        logger.error('获取 Provider 列表失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=f'获取 Provider 列表失败: {e}')


@router.post('/providers')
async def create_provider(request: Request):
    """创建新的 Provider。"""
    try:
        body = await request.json()
        provider_key = await asyncio.to_thread(_get_service().create_provider, body)
        return {
            **ok(data={'provider_key': provider_key}, message='Provider 创建成功'),
            'provider_key': provider_key,
        }
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('创建 Provider 失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=f'创建 Provider 失败: {e}')


@router.put('/providers/{provider_key}')
async def update_provider(provider_key: str, request: Request):
    """更新 Provider。"""
    try:
        body = await request.json()
        updated_key = await asyncio.to_thread(_get_service().update_provider, provider_key, body)
        return {
            **ok(data={'provider_key': updated_key}, message='Provider 更新成功'),
            'provider_key': updated_key,
        }
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('更新 Provider 失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=f'更新 Provider 失败: {e}')


@router.delete('/providers/{provider_key}')
async def delete_provider(provider_key: str):
    """删除 Provider。"""
    try:
        await asyncio.to_thread(_get_service().delete_provider, provider_key)
        return ok(message='Provider 删除成功')
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('删除 Provider 失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=f'删除 Provider 失败: {e}')


@router.get('/providers/{provider_key}/check')
async def check_provider_availability(provider_key: str):
    """检查 Provider 可用性。"""
    try:
        result = await asyncio.to_thread(_get_service().check_provider_availability, provider_key)
        return {**ok(data=result, message='检查成功'), **result}
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('检查 Provider 可用性失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=f'检查失败: {e}')


@router.post('/test')
async def test_provider(request: Request):
    """测试 Provider。"""
    try:
        body = await request.json()
        result = await asyncio.to_thread(_get_service().test_provider, body)
        return {**ok(data=result, message='测试成功'), 'response': result}
    except Exception as e:
        if hasattr(e, 'status_code'):
            raise HTTPException(status_code=e.status_code, detail=e.message)
        logger.error('测试 Provider 失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=f'测试 Provider 失败: {e}')
