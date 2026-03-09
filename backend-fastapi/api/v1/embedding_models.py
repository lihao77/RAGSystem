# -*- coding: utf-8 -*-
"""Embedding 模型管理 API 路由。"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

logger = logging.getLogger(__name__)
router = APIRouter()


def _svc():
    from services.embedding_model_service import get_embedding_model_service
    return get_embedding_model_service()


def _err(e):
    if hasattr(e, 'status_code') and hasattr(e, 'message'):
        raise HTTPException(status_code=e.status_code, detail=e.message)
    raise HTTPException(status_code=500, detail=str(e))


@router.get('/models')
async def list_models():
    try:
        models = await asyncio.to_thread(_svc().list_models)
        return {'success': True, 'models': models}
    except Exception as e:
        _err(e)


@router.post('/models/{model_id}/activate')
async def activate_model(model_id: int):
    try:
        data = await asyncio.to_thread(_svc().activate_model, model_id)
        return {'success': True, **data}
    except Exception as e:
        _err(e)


@router.delete('/models/{model_id}')
async def delete_model(model_id: int, force: bool = Query(False)):
    try:
        data = await asyncio.to_thread(_svc().delete_model, model_id, force=force)
        return {'success': True, **data}
    except Exception as e:
        _err(e)


@router.post('/models/{model_id}/sync')
async def sync_model(model_id: int, request: Request):
    try:
        body = await request.json() if request.headers.get('content-type', '').startswith('application/json') else {}
        result = await asyncio.to_thread(
            _svc().sync_model,
            model_id,
            collection=body.get('collection', 'default'),
            batch_size=body.get('batch_size', 50),
            limit=body.get('limit'),
        )
        return {'success': True, 'result': result}
    except Exception as e:
        _err(e)


@router.get('/models/{model_id}/stats')
async def get_model_stats(model_id: int, collection: Optional[str] = Query(None)):
    try:
        stats = await asyncio.to_thread(_svc().get_model_stats, model_id, collection=collection)
        return {'success': True, 'stats': stats}
    except Exception as e:
        _err(e)


@router.get('/models/sync-status')
async def get_sync_status(collection: str = Query('default')):
    try:
        sync_status = await asyncio.to_thread(_svc().get_sync_status, collection=collection)
        return {'success': True, 'collection': collection, 'sync_status': sync_status}
    except Exception as e:
        _err(e)
