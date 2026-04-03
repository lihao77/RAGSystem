# -*- coding: utf-8 -*-
"""
文件管理 API 路由。
"""

import asyncio
import logging
import os
import re
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from core.path_resolution import get_uploads_root

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_index():
    from dependencies import get_file_index
    return get_file_index()


def _get_upload_folder() -> Path:
    folder = get_uploads_root()
    folder.mkdir(parents=True, exist_ok=True)
    return folder


@router.get('')
async def list_files(
    extensions: Optional[str] = None,
    mime_types: Optional[str] = None,
):
    """列出文件，支持按扩展名和 MIME 类型过滤。"""
    index = _get_index()
    items = await asyncio.to_thread(index.list, scope_type='global', scope_id=None)

    ext_list = [e.lower().strip() for e in extensions.split(',') if e.strip()] if extensions else None
    mime_list = [m.lower().strip() for m in mime_types.split(',') if m.strip()] if mime_types else None

    if ext_list and mime_list:
        items = [
            f for f in items
            if any(f.get('original_name', '').lower().endswith(e) for e in ext_list)
            or f.get('mime', '').lower() in mime_list
        ]
    elif ext_list:
        items = [f for f in items if any(f.get('original_name', '').lower().endswith(e) for e in ext_list)]
    elif mime_list:
        items = [f for f in items if f.get('mime', '').lower() in mime_list]

    return {'success': True, 'files': items}


@router.get('/validate')
async def validate_files(request: Request):
    """验证文件 ID 是否存在。"""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail='缺少请求体')

    file_ids = body.get('file_ids', [])
    if not isinstance(file_ids, list):
        raise HTTPException(status_code=400, detail='file_ids 必须是数组')

    index = _get_index()
    valid = []
    invalid = []
    for fid in file_ids:
        rec = await asyncio.to_thread(index.get, fid, scope_type='global', scope_id=None)
        if rec:
            valid.append(fid)
        else:
            invalid.append(fid)

    return {'success': True, 'valid': valid, 'invalid': invalid}


@router.post('/validate')
async def validate_files_post(request: Request):
    """验证文件 ID 是否存在（POST）。"""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail='缺少请求体')

    file_ids = body.get('file_ids', [])
    if not isinstance(file_ids, list):
        raise HTTPException(status_code=400, detail='file_ids 必须是数组')

    index = _get_index()
    valid = []
    invalid = []
    for fid in file_ids:
        rec = await asyncio.to_thread(index.get, fid, scope_type='global', scope_id=None)
        if rec:
            valid.append(fid)
        else:
            invalid.append(fid)

    return {'success': True, 'valid': valid, 'invalid': invalid}


@router.get('/{file_id}')
async def get_file(file_id: str):
    """获取文件信息。"""
    if file_id == 'validate':
        raise HTTPException(status_code=404, detail='Not found')
    index = _get_index()
    rec = await asyncio.to_thread(index.get, file_id, scope_type='global', scope_id=None)
    if not rec:
        raise HTTPException(status_code=404, detail='文件不存在')
    return {'success': True, 'file': rec}


@router.post('/upload')
async def upload_files(files: List[UploadFile] = File(...)):
    """上传文件。"""
    if not files:
        raise HTTPException(status_code=400, detail='未选择文件')

    upload_dir = _get_upload_folder()
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
            scope_type='global',
            scope_id=None,
        )
        created.append(rec)

    return {'success': True, 'files': created}


def _write_file(path: Path, content: bytes) -> None:
    path.write_bytes(content)


@router.delete('/{file_id}')
async def delete_file(file_id: str):
    """删除文件。"""
    index = _get_index()
    rec = await asyncio.to_thread(index.get, file_id, scope_type='global', scope_id=None)
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
async def download_file(file_id: str):
    """下载文件。"""
    index = _get_index()
    rec = await asyncio.to_thread(index.get, file_id, scope_type='global', scope_id=None)
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
