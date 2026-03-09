# -*- coding: utf-8 -*-
"""
会话管理 API 路由。
"""

import asyncio
import logging
import uuid

from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from schemas.session import (
    CreateSessionRequest,
    RollbackRequest,
    RollbackAndRetryRequest,
    UpdateMessageRequest,
    RecoverSessionRequest,
)
from schemas.common import ok

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_session_app():
    from dependencies import get_agent_runtime_service
    return get_agent_runtime_service().get_session_application()


def _get_collab_app():
    from dependencies import get_agent_runtime_service
    return get_agent_runtime_service().get_collaboration_application()


@router.post('/sessions')
async def create_session(request: CreateSessionRequest):
    """创建会话。"""
    try:
        session_id = request.session_id or str(uuid.uuid4())
        data = await asyncio.to_thread(
            _get_session_app().create_session,
            session_id=session_id,
            user_id=request.user_id,
            metadata=request.metadata or {},
        )
        return ok(data=data, message='会话创建成功')
    except Exception as e:
        logger.error('创建会话失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/sessions')
async def list_sessions(
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user_id: Optional[str] = Query(None),
):
    """列出会话。"""
    try:
        if user_id is not None and user_id.strip() == '':
            user_id = None
        data = await asyncio.to_thread(
            _get_session_app().list_sessions,
            limit=limit, offset=offset, user_id=user_id
        )
        return ok(data=data, message='获取会话列表成功')
    except Exception as e:
        logger.error('获取会话列表失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/sessions/{session_id}')
async def get_session(session_id: str):
    """获取指定会话。"""
    try:
        session = await asyncio.to_thread(_get_session_app().get_session, session_id)
        if not session:
            raise HTTPException(status_code=404, detail='会话不存在')
        return ok(data=session, message='获取会话成功')
    except HTTPException:
        raise
    except Exception as e:
        logger.error('获取会话失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete('/sessions/{session_id}')
async def delete_session(session_id: str):
    """删除会话及其所有消息。"""
    try:
        deleted = await asyncio.to_thread(_get_session_app().delete_session, session_id)
        if not deleted:
            raise HTTPException(status_code=404, detail='会话不存在')
        return ok(message='会话删除成功')
    except HTTPException:
        raise
    except Exception as e:
        logger.error('删除会话失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/sessions/{session_id}/messages')
async def get_session_messages(
    session_id: str,
    limit: int = Query(20, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    expand: str = Query('steps'),
):
    """获取会话消息。"""
    try:
        expand_steps = expand.lower() in ('1', 'true', 'steps', 'yes')
        data = await asyncio.to_thread(
            _get_session_app().list_messages,
            session_id=session_id,
            limit=limit,
            offset=offset,
            expand_steps=expand_steps,
        )
        return ok(data=data, message='获取对话记录成功')
    except Exception as e:
        logger.error('获取对话记录失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch('/sessions/{session_id}/messages/{message_id}')
async def update_session_message(session_id: str, message_id: str, request: UpdateMessageRequest):
    """更新某条消息内容（主要用于编辑 user 消息）。"""
    try:
        updated = await asyncio.to_thread(
            _get_session_app().update_user_message,
            session_id=session_id,
            message_id=message_id,
            content=request.content,
        )
        if not updated:
            raise HTTPException(status_code=404, detail='消息不存在或不可编辑')
        return ok(data={'message_id': message_id}, message='更新成功')
    except HTTPException:
        raise
    except Exception as e:
        logger.error('更新消息失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/sessions/{session_id}/rollback')
async def rollback_session(session_id: str, request: RollbackRequest):
    """回退到某条消息：删除该条之后的所有消息及关联 run_steps。"""
    try:
        if request.after_seq is None and not request.after_message_id:
            raise HTTPException(status_code=400, detail='请提供 after_seq 或 after_message_id')
        deleted = await asyncio.to_thread(
            _get_session_app().rollback_messages,
            session_id=session_id,
            after_seq=request.after_seq,
            after_message_id=request.after_message_id,
        )
        return ok(data={'deleted': deleted}, message='回退成功')
    except HTTPException:
        raise
    except Exception as e:
        logger.error('回退失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/sessions/{session_id}/rollback-and-retry')
async def rollback_and_retry(session_id: str, request: RollbackAndRetryRequest):
    """回退到某条消息并自动重试。"""
    try:
        result = await asyncio.to_thread(
            _get_collab_app().rollback_and_retry,
            session_id,
            request.model_dump(exclude_none=True),
        )
        return ok(
            data=result,
            message='重试成功' if result.get('success') else '重试执行完成但未得到成功结果'
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error('回退并重试失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/sessions/{session_id}/recover')
async def recover_session(session_id: str, request: RecoverSessionRequest):
    """从检查点恢复会话执行。"""
    try:
        data = await asyncio.to_thread(
            _get_collab_app().recover_session,
            session_id,
            request.model_dump(exclude_none=True),
        )
        return ok(
            data=data,
            message='从检查点恢复成功' if data.get('success') else '恢复执行完成但未成功'
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error('从检查点恢复失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/sessions/{session_id}/checkpoints')
async def list_session_checkpoints(
    session_id: str,
    agent_name: Optional[str] = Query(None),
    limit: int = Query(10, ge=1, le=100),
):
    """列出会话的检查点。"""
    try:
        data = await asyncio.to_thread(
            _get_collab_app().list_checkpoints,
            session_id,
            agent_name=agent_name,
            limit=limit,
        )
        return ok(data=data, message='获取检查点列表成功')
    except Exception as e:
        logger.error('获取检查点列表失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
