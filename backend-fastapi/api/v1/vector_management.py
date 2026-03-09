# -*- coding: utf-8 -*-
"""向量管理 API 路由。"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Form
from typing import Optional

logger = logging.getLogger(__name__)
router = APIRouter()


def _svc():
    from services.vector_management_service import get_vector_management_service
    return get_vector_management_service()


def _err(e):
    if hasattr(e, 'status_code') and hasattr(e, 'message'):
        raise HTTPException(status_code=e.status_code, detail=e.message)
    raise HTTPException(status_code=500, detail=str(e))


@router.get('/collections')
async def list_collections():
    try:
        data = await asyncio.to_thread(_svc().list_collections)
        return {'success': True, 'data': data, 'count': len(data)}
    except Exception as e:
        _err(e)


@router.delete('/collections/{collection_name}')
async def delete_collection(collection_name: str):
    try:
        data = await asyncio.to_thread(_svc().delete_collection, collection_name)
        return {'success': True, **data}
    except Exception as e:
        _err(e)


@router.post('/search')
async def search_vectors(request: Request):
    try:
        body = await request.json()
        data = await asyncio.to_thread(_svc().search_vectors, body)
        return {'success': True, 'data': data}
    except Exception as e:
        _err(e)


@router.post('/index')
async def index_document(
    request: Request,
    file: Optional[UploadFile] = File(None),
):
    try:
        if file is not None:
            # 文件上传模式
            content = await file.read()
            import tempfile, os
            suffix = os.path.splitext(file.filename or '')[1]
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(content)
                tmp_path = tmp.name

            # 构造类 werkzeug FileStorage 的简单对象
            class _FakeFile:
                filename = file.filename
                content_type = file.content_type
                def read(self): return content
                def save(self, path):
                    with open(path, 'wb') as f: f.write(content)

            form_data = dict(await request.form())
            data = await asyncio.to_thread(
                _svc().index_document,
                payload=None,
                uploaded_file=_FakeFile(),
                form={k: v for k, v in form_data.items() if k != 'file'},
            )
            import os; os.unlink(tmp_path)
        else:
            body = await request.json()
            data = await asyncio.to_thread(_svc().index_document, payload=body, uploaded_file=None, form=None)

        message = data.pop('message', '索引成功')
        return {'success': True, 'data': data, 'message': message}
    except Exception as e:
        _err(e)


@router.delete('/documents/{collection_name}/{document_id}')
async def delete_document(collection_name: str, document_id: str):
    try:
        data = await asyncio.to_thread(_svc().delete_document, collection_name, document_id)
        return {'success': True, **data}
    except Exception as e:
        _err(e)


@router.get('/documents/{collection_name}')
async def list_documents(collection_name: str):
    try:
        data = await asyncio.to_thread(_svc().list_documents, collection_name)
        return {'success': True, 'data': data}
    except Exception as e:
        _err(e)


@router.get('/health')
async def health_check():
    try:
        data = await asyncio.to_thread(_svc().health_check)
        return {'success': True, 'data': data}
    except Exception as e:
        if hasattr(e, 'status_code') and hasattr(e, 'message'):
            raise HTTPException(
                status_code=e.status_code,
                detail={'success': False, 'error': e.message, 'data': {'status': 'unhealthy'}},
            )
        raise HTTPException(status_code=500, detail=str(e))
