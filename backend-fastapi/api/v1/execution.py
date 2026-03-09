# -*- coding: utf-8 -*-
"""
Agent 同步执行 API 路由。
"""

import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException

from dependencies import (
    get_orchestrator,
    get_conversation_store,
    get_execution_service,
)
from schemas.execution import ExecuteRequest, CollaborateRequest
from schemas.common import ok

logger = logging.getLogger(__name__)
router = APIRouter()


def _load_history(runtime_service, context, session_id: str, limit: int = 50):
    return runtime_service.load_history_into_context(context, session_id=session_id, limit=limit)


@router.post('/execute')
async def execute(request: ExecuteRequest):
    """执行智能体任务（自动路由）。"""
    try:
        from dependencies import get_agent_runtime_service
        from agents import AgentContext

        runtime = get_agent_runtime_service()
        orchestrator = runtime.get_orchestrator()
        store = runtime.get_conversation_store()

        session_id = request.session_id or str(uuid.uuid4())
        context = AgentContext(session_id=session_id, user_id=request.user_id)

        await asyncio.to_thread(store.create_session, session_id=session_id, user_id=request.user_id)
        await asyncio.to_thread(_load_history, runtime, context, session_id, 50)
        await asyncio.to_thread(
            store.add_message,
            session_id=session_id, role='user', content=request.task,
            metadata={'agent': request.agent}
        )

        response = await asyncio.to_thread(
            orchestrator.execute,
            task=request.task,
            context=context,
            preferred_agent=request.agent,
        )

        if response.success:
            if response.content:
                await asyncio.to_thread(
                    store.add_message,
                    session_id=session_id, role='assistant', content=response.content,
                    metadata={'agent': response.agent_name}
                )
            return ok(
                data={
                    'answer': response.content,
                    'agent_name': response.agent_name,
                    'execution_time': response.execution_time,
                    'tool_calls': response.tool_calls,
                    'metadata': response.metadata,
                    'session_id': session_id,
                },
                message='任务执行成功'
            )
        else:
            raise HTTPException(status_code=500, detail=response.error or '任务执行失败')

    except HTTPException:
        raise
    except Exception as e:
        logger.error('执行任务失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/execute/{agent_name}')
async def execute_specific_agent(agent_name: str, request: ExecuteRequest):
    """执行指定智能体。"""
    try:
        from dependencies import get_agent_runtime_service
        from agents import AgentContext

        runtime = get_agent_runtime_service()
        orchestrator = runtime.get_orchestrator()
        store = runtime.get_conversation_store()

        session_id = request.session_id or str(uuid.uuid4())
        context = AgentContext(session_id=session_id, user_id=request.user_id)

        await asyncio.to_thread(store.create_session, session_id=session_id, user_id=request.user_id)
        await asyncio.to_thread(_load_history, runtime, context, session_id, 50)
        await asyncio.to_thread(
            store.add_message,
            session_id=session_id, role='user', content=request.task,
            metadata={'agent': agent_name}
        )

        response = await asyncio.to_thread(
            orchestrator.execute,
            task=request.task,
            context=context,
            preferred_agent=agent_name,
        )

        if response.success:
            if response.content:
                await asyncio.to_thread(
                    store.add_message,
                    session_id=session_id, role='assistant', content=response.content,
                    metadata={'agent': response.agent_name}
                )
            return ok(
                data={
                    'answer': response.content,
                    'agent_name': response.agent_name,
                    'execution_time': response.execution_time,
                    'tool_calls': response.tool_calls,
                    'metadata': response.metadata,
                    'session_id': session_id,
                },
                message='任务执行成功'
            )
        else:
            raise HTTPException(status_code=500, detail=response.error or '任务执行失败')

    except HTTPException:
        raise
    except Exception as e:
        logger.error('执行任务失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/collaborate')
async def collaborate(request: CollaborateRequest):
    """多智能体协作。"""
    try:
        from dependencies import get_agent_runtime_service
        from agents import AgentContext

        runtime = get_agent_runtime_service()
        orchestrator = runtime.get_orchestrator()
        store = runtime.get_conversation_store()

        session_id = request.session_id or str(uuid.uuid4())
        context = AgentContext(session_id=session_id, user_id=request.user_id)

        await asyncio.to_thread(store.create_session, session_id=session_id, user_id=request.user_id)
        await asyncio.to_thread(_load_history, runtime, context, session_id, 50)

        tasks_data = [t.model_dump() for t in request.tasks]
        for t in tasks_data:
            task_content = (t.get('task') or '').strip()
            if task_content:
                await asyncio.to_thread(
                    store.add_message,
                    session_id=session_id, role='user', content=task_content,
                    metadata={'agent': t.get('agent')}
                )

        results = await asyncio.to_thread(
            orchestrator.collaborate,
            tasks=tasks_data,
            context=context,
            mode=request.mode,
        )

        results_data = [
            {
                'success': r.success,
                'content': r.content,
                'error': r.error,
                'agent_name': r.agent_name,
                'execution_time': r.execution_time,
            }
            for r in results
        ]

        for r in results:
            if r and r.content:
                await asyncio.to_thread(
                    store.add_message,
                    session_id=session_id, role='assistant', content=r.content,
                    metadata={'agent': r.agent_name}
                )

        return ok(
            data={
                'results': results_data,
                'session_id': session_id,
                'total_tasks': len(tasks_data),
            },
            message='协作任务执行完成'
        )

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
        'scope': 'session_id',
        'scope_id': session_id,
        'found': status is not None,
        'has_running_task': status is not None and status.get('status') == 'running',
        'task_info': status,
        'observability': diagnostics.get('observability') if diagnostics is not None else None,
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
