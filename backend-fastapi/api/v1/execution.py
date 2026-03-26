# -*- coding: utf-8 -*-
"""
Agent 同步执行 API 路由。
"""

import asyncio
import logging
import uuid

from fastapi import APIRouter, HTTPException

from agents.core.base import AgentExecutionError

from dependencies import get_execution_service
from schemas.execution import ExecuteRequest, CollaborateRequest
from schemas.common import ok
from services.agent_execution_service import get_agent_execution_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post('/execute')
async def execute(request: ExecuteRequest):
    """执行智能体任务（自动路由）。"""
    try:
        from dependencies import get_agent_runtime_service
        from agents.events.session_manager import cleanup_run

        runtime = get_agent_runtime_service()
        store = runtime.get_conversation_store()
        agent_execution_service = get_agent_execution_service()

        session_id = request.session_id or str(uuid.uuid4())
        await asyncio.to_thread(
            lambda: store.get_session(session_id) or store.create_session(session_id=session_id, user_id=request.user_id)
        )

        target_agent = request.agent or 'orchestrator_agent'
        invocation = await asyncio.to_thread(
            agent_execution_service.invoke_agent,
            mode='root',
            agent_name=target_agent,
            task=request.task,
            session_id=session_id,
            user_id=request.user_id,
            entrypoint='execute',
            source='api',
            persist_user_message=True,
            persist_final_answer=True,
            visible_to_user=True,
        )

        try:
            response = invocation.response
        finally:
            cleanup_run(invocation.run_id)

        if response.success:
            return ok(
                data={
                    'answer': response.content,
                    'agent_name': response.agent_name,
                    'execution_time': response.execution_time,
                    'tool_calls': response.tool_calls,
                    'metadata': {
                        **(response.metadata or {}),
                        'run_id': invocation.run_id,
                        'thread_key': invocation.thread_key,
                        'child_agent_id': invocation.child_agent_id,
                    },
                    'session_id': session_id,
                },
                message='任务执行成功'
            )
        raise HTTPException(status_code=500, detail=response.error or '任务执行失败')

    except HTTPException:
        raise
    except Exception as e:
        logger.error('执行任务失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/execute/{agent_name}')
async def execute_specific_agent(agent_name: str, request: ExecuteRequest):
    """执行指定智能体。"""
    payload = request.model_copy(update={'agent': agent_name})
    return await execute(payload)


@router.post('/collaborate')
async def collaborate(request: CollaborateRequest):
    """多智能体协作。"""
    try:
        from dependencies import get_agent_runtime_service
        from agents.events.session_manager import cleanup_run

        if request.mode != 'sequential':
            raise HTTPException(status_code=400, detail='并行模式尚未实现')

        runtime = get_agent_runtime_service()
        store = runtime.get_conversation_store()
        agent_execution_service = get_agent_execution_service()

        session_id = request.session_id or str(uuid.uuid4())
        await asyncio.to_thread(
            lambda: store.get_session(session_id) or store.create_session(session_id=session_id, user_id=request.user_id)
        )

        results = []
        for task_item in request.tasks:
            invocation = await asyncio.to_thread(
                agent_execution_service.invoke_routed_agent,
                task=task_item.task,
                session_id=session_id,
                preferred_agent=task_item.agent,
                user_id=request.user_id,
                entrypoint='collaborate',
                source='api',
                persist_user_message=True,
                persist_final_answer=True,
                visible_to_user=True,
            )
            try:
                response = invocation.response
                results.append({
                    'success': response.success,
                    'content': response.content,
                    'error': response.error,
                    'agent_name': response.agent_name,
                    'execution_time': response.execution_time,
                })
            finally:
                cleanup_run(invocation.run_id)

        return ok(
            data={
                'results': results,
                'session_id': session_id,
                'total_tasks': len(request.tasks),
            },
            message='协作任务执行完成'
        )

    except AgentExecutionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error('协作任务执行失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/sessions/{session_id}/task-status')
async def get_session_task_status(session_id: str):
    """查询会话的当前任务执行状态。"""
    execution_service = get_execution_service()
    status = await asyncio.to_thread(execution_service.get_status_by_session, session_id)
    diagnostics = await asyncio.to_thread(execution_service.get_diagnostics_by_session, session_id)
    return ok(data={
        'session_id': session_id,
        'has_running_task': status is not None and status.get('status') == 'running',
        'task_info': status,
        'observability': (
            {
                'task_id': status.get('task_id'),
                'session_id': status.get('session_id'),
                'run_id': status.get('run_id'),
                'execution_kind': status.get('execution_kind'),
                'request_id': status.get('request_id'),
            }
            if status is not None else None
        ),
        'diagnostics': diagnostics,
    })


@router.get('/sessions/{session_id}/execution-diagnostics')
async def get_session_execution_diagnostics(session_id: str):
    """查询会话的 execution diagnostics。"""
    execution_service = get_execution_service()
    diagnostics = await asyncio.to_thread(execution_service.get_diagnostics_by_session, session_id)
    return ok(data={
        'session_id': session_id,
        'scope': 'session_id',
        'scope_id': session_id,
        'found': diagnostics is not None,
        'diagnostics': diagnostics,
    })


@router.get('/tasks/{task_id}/execution-diagnostics')
async def get_task_execution_diagnostics(task_id: str):
    """按 task_id 查询 execution diagnostics。"""
    execution_service = get_execution_service()
    diagnostics = await asyncio.to_thread(execution_service.get_diagnostics, task_id)
    return ok(data={
        'task_id': task_id,
        'scope': 'task_id',
        'scope_id': task_id,
        'found': diagnostics is not None,
        'diagnostics': diagnostics,
    })


@router.get('/tasks/{task_id}/status')
async def get_task_status(task_id: str):
    """按 task_id 查询任务状态。"""
    execution_service = get_execution_service()
    status = await asyncio.to_thread(execution_service.get_status, task_id)
    return ok(data={
        'task_id': task_id,
        'scope': 'task_id',
        'scope_id': task_id,
        'found': status is not None,
        'has_running_task': status is not None and status.get('status') == 'running',
        'task_info': status,
        'observability': (
            {
                'task_id': status.get('task_id'),
                'session_id': status.get('session_id'),
                'run_id': status.get('run_id'),
                'execution_kind': status.get('execution_kind'),
                'request_id': status.get('request_id'),
            }
            if status is not None else None
        ),
    })


@router.get('/tasks/running')
async def list_running_tasks():
    """列出当前运行中的任务状态。"""
    execution_service = get_execution_service()
    items = await asyncio.to_thread(execution_service.list_statuses, active_only=True)
    return ok(data={
        'active_only': True,
        'count': len(items),
        'items': items,
    })


@router.get('/execution/overview')
async def get_execution_overview(active_only: str = 'true'):
    """获取 execution plane 的聚合概览。"""
    execution_service = get_execution_service()
    is_active_only = active_only.strip().lower() not in {'0', 'false', 'no', 'off'}
    overview = await asyncio.to_thread(lambda: execution_service.get_overview(active_only=is_active_only))
    return ok(data=overview)
