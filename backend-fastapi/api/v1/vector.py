# -*- coding: utf-8 -*-
"""
向量库管理 API 路由。
"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_capability():
    from dependencies import get_vector_retrieval_capability
    return get_vector_retrieval_capability()


def _handle_error(e: Exception):
    if hasattr(e, 'status_code') and hasattr(e, 'message'):
        raise HTTPException(status_code=e.status_code, detail=e.message)
    raise HTTPException(status_code=500, detail=str(e))


@router.get('/file-status')
async def file_status():
    """获取文件索引状态。"""
    try:
        data = await asyncio.to_thread(_get_capability().file_status)
        return {'success': True, 'data': data}
    except Exception as e:
        _handle_error(e)


@router.post('/index-file')
async def index_file_with_vectorizer(request: Request):
    """按向量化器索引文件。"""
    try:
        body = await request.json()
        data = await asyncio.to_thread(_get_capability().index_file, body)
        return {'success': True, 'data': data}
    except Exception as e:
        _handle_error(e)


@router.post('/delete-file')
async def delete_file(request: Request):
    """删除文件的向量索引。"""
    try:
        body = await request.json()
        data = await asyncio.to_thread(_get_capability().delete_file, body)
        return {'success': True, 'data': data}
    except Exception as e:
        _handle_error(e)


@router.get('/vectorizers')
async def list_vectorizers():
    """列出所有向量化器。"""
    try:
        data = await asyncio.to_thread(_get_capability().list_vectorizers)
        return {'success': True, 'data': data}
    except Exception as e:
        _handle_error(e)


@router.post('/vectorizers')
async def add_vectorizer(request: Request):
    """添加向量化器。"""
    try:
        body = await request.json()
        data = await asyncio.to_thread(_get_capability().add_vectorizer, body)
        return {'success': True, 'data': data}
    except Exception as e:
        _handle_error(e)


@router.post('/vectorizers/{key}/activate')
async def activate_vectorizer(key: str):
    """激活指定向量化器。"""
    try:
        data = await asyncio.to_thread(_get_capability().activate_vectorizer, key)
        return {'success': True, 'data': data}
    except Exception as e:
        _handle_error(e)


@router.get('/vectorizers/{key}/docs')
async def list_docs_by_vectorizer(
    key: str,
    collection: Optional[str] = Query(None),
):
    """按向量化器查询文档。"""
    try:
        data = await asyncio.to_thread(_get_capability().list_docs_by_vectorizer, key, collection)
        return {'success': True, 'data': data}
    except Exception as e:
        _handle_error(e)


@router.delete('/vectorizers/{key}')
async def delete_vectorizer(key: str):
    """删除向量化器。"""
    try:
        data = await asyncio.to_thread(_get_capability().delete_vectorizer, key)
        return {'success': True, 'data': data}
    except Exception as e:
        _handle_error(e)


@router.post('/migrate')
async def migrate(request: Request):
    """迁移向量数据。"""
    try:
        body = await request.json() if request.headers.get('content-type', '').startswith('application/json') else {}
        data = await asyncio.to_thread(_get_capability().migrate, body)
        return {'success': True, 'data': data}
    except Exception as e:
        _handle_error(e)
