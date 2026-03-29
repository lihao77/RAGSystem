# -*- coding: utf-8 -*-
"""
session 文件管理 API 路由。
"""

import asyncio
import logging
import os
import re
from pathlib import Path
from typing import List

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from tools.paths.path_resolution import get_session_uploads_root

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_index():
    from dependencies import get_file_index
    return get_file_index()


def _get_upload_folder(session_id: str) -> Path:
    folder = get_session_uploads_root(session_id)
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _write_file(path: Path, content: bytes) -> None:
    path.write_bytes(content)


async def _read_validate_body(request: Request) -> list[str]:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail='缺少请求体')
    file_ids = body.get('file_ids', [])
    if not isinstance(file_ids, list):
        raise HTTPException(status_code=400, detail='file_ids 必须是数组')
    return file_ids


@router.get('')
async def list_session_files(session_id: str):
    """列出指定会话的文件。"""
    index = _get_index()
    items = await asyncio.to_thread(index.list, scope_type='session', scope_id=session_id)
    return {'success': True, 'files': items}


@router.post('/validate')
async def validate_session_files(session_id: str, request: Request):
    """验证指定会话中的文件 ID 是否存在。"""
    file_ids = await _read_validate_body(request)
    index = _get_index()
    valid = []
    invalid = []
    for fid in file_ids:
        rec = await asyncio.to_thread(index.get, fid, scope_type='session', scope_id=session_id)
        if rec:
            valid.append(fid)
        else:
            invalid.append(fid)
    return {'success': True, 'valid': valid, 'invalid': invalid}


@router.get('/{file_id}')
async def get_session_file(session_id: str, file_id: str):
    """获取指定会话文件信息。"""
    index = _get_index()
    rec = await asyncio.to_thread(index.get, file_id, scope_type='session', scope_id=session_id)
    if not rec:
        raise HTTPException(status_code=404, detail='文件不存在')
    return {'success': True, 'file': rec}


@router.post('/upload')
async def upload_session_files(session_id: str, files: List[UploadFile] = File(...)):
    """上传文件到指定会话。"""
    if not files:
        raise HTTPException(status_code=400, detail='未选择文件')

    upload_dir = _get_upload_folder(session_id)
    index = _get_index()
    created = []

    for f in files:
        if not f or not f.filename:
            continue
        safe_name = re.sub(r'[^\w\-_\.]', '_', f.filename)
        stored_name = f'{os.urandom(8).hex()}_{safe_name}'
        stored_path = upload_dir / stored_name
        content = await f.read()
        await asyncio.to_thread(_write_file, stored_path, content)
        rec = await asyncio.to_thread(
            index.add,
            original_name=f.filename,
            stored_name=stored_name,
            stored_path=str(stored_path),
            size=stored_path.stat().st_size,
            mime=f.content_type or '',
            scope_type='session',
            scope_id=session_id,
        )
        created.append(rec)

    return {'success': True, 'files': created}


@router.delete('/{file_id}')
async def delete_session_file(session_id: str, file_id: str):
    """删除指定会话文件。"""
    index = _get_index()
    rec = await asyncio.to_thread(index.get, file_id, scope_type='session', scope_id=session_id)
    if not rec:
        raise HTTPException(status_code=404, detail='文件不存在')
    try:
        p = Path(rec.get('stored_path', ''))
        if p.exists() and p.is_file():
            await asyncio.to_thread(p.unlink)
    except Exception:
        pass
    result = await asyncio.to_thread(index.delete, file_id)
    if result:
        return {'success': True}
    raise HTTPException(status_code=500, detail='删除失败')


@router.get('/{file_id}/download')
async def download_session_file(session_id: str, file_id: str):
    """下载指定会话文件。"""
    index = _get_index()
    rec = await asyncio.to_thread(index.get, file_id, scope_type='session', scope_id=session_id)
    if not rec:
        raise HTTPException(status_code=404, detail='文件不存在')
    file_path = Path(rec.get('stored_path', ''))
    if not file_path.exists():
        raise HTTPException(status_code=404, detail='文件不存在于磁盘')
    return FileResponse(
        path=str(file_path),
        filename=rec.get('original_name') or file_path.name,
        media_type='application/octet-stream',
    )
