# -*- coding: utf-8 -*-
"""
Agent 流式执行 API 路由（SSE）。
"""

import asyncio
import json
import logging
import uuid
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException, Request
from starlette.responses import StreamingResponse

from dependencies import get_execution_service, get_session_event_bus
from schemas.execution import StreamExecuteRequest, StreamReconnectRequest, StreamStopRequest, ApprovalRequest, UserInputRequest
from schemas.common import ok
from .stream_utils import sync_to_async_sse

logger = logging.getLogger(__name__)
router = APIRouter()


def _parse_selected_llm(selected_llm: str):
    """解析前端选择的 LLM 字符串。"""
    selected_llm = (selected_llm or '').strip()
    if not selected_llm:
        return None
    parts = selected_llm.split('|')
    if len(parts) >= 3:
        return {'provider': parts[0], 'provider_type': parts[1], 'model_name': parts[2]}
    if len(parts) == 2:
        return {'provider': parts[0], 'provider_type': '', 'model_name': parts[1]}
    if len(parts) == 1 and parts[0]:
        return {'provider': parts[0], 'provider_type': None, 'model_name': None}
    return None


def _apply_observability(payload: dict, obs: dict) -> None:
    """注入可观测性字段。"""
    try:
        from execution.observability import apply_observability_fields
        apply_observability_fields(payload, obs)
    except Exception:
        pass


def _ensure_request_id(request_id=None) -> str:
    """确保 request_id 存在。"""
    try:
        from execution.observability import ensure_request_id
        return ensure_request_id(request_id)
    except Exception:
        return request_id or str(uuid.uuid4())[:8]


@router.post('/stream')
async def stream_execute(request: StreamExecuteRequest, http_request: Request):
    """
    流式执行智能体任务（SSE）。

    Response: text/event-stream
    """
    task = request.task.strip()
    if not task:
        raise HTTPException(status_code=400, detail='任务描述不能为空')

    session_id = request.session_id or str(uuid.uuid4())
    user_id = request.user_id
    request_id = _ensure_request_id(http_request.headers.get('X-Request-ID'))

    selected_llm_str = request.selected_llm or ''
    llm_override = _parse_selected_llm(selected_llm_str)

    logger.info('流式执行任务: session_id=%s request_id=%s task=%s', session_id, request_id, task)

    def _sse_line(payload: dict, **dumps_kwargs) -> str:
        return f"data: {json.dumps(payload, ensure_ascii=False, **dumps_kwargs)}\n\n"

    async def event_generator() -> AsyncGenerator[str, None]:
        try:
            from execution.adapters.agent_execution import AgentExecutionAdapter
            from dependencies import get_agent_runtime_service

            runtime = get_agent_runtime_service()

            def _start_stream():
                return AgentExecutionAdapter().start_stream_execution(
                    task=task,
                    session_id=session_id,
                    user_id=user_id,
                    llm_override=llm_override,
                    request_id=request_id,
                    conversation_store=runtime.get_conversation_store(),
                    orchestrator=runtime.get_orchestrator(),
                    history_loader=runtime.load_history_into_context,
                )

            started = await asyncio.to_thread(_start_stream)

            if not started.started or started.sse_adapter is None:
                error_payload = {
                    'type': 'error',
                    'content': started.error_message or '启动流式任务失败',
                    'session_id': session_id,
                }
                _apply_observability(error_payload, {
                    'task_id': started.task_id,
                    'session_id': session_id,
                    'run_id': started.run_id,
                    'execution_kind': 'agent_stream',
                    'request_id': started.request_id or request_id,
                })
                yield _sse_line(error_payload)
                return

            queue: asyncio.Queue = asyncio.Queue()
            loop = asyncio.get_event_loop()

            def _cleanup():
                try:
                    from services.execution_service import get_execution_service as _get_exec
                    _get_exec().cleanup_finished()
                except Exception:
                    pass

            async for sse_line in sync_to_async_sse(
                sync_stream=started.sse_adapter.stream_sync,
                session_id=session_id,
                cleanup_callback=_cleanup,
            ):
                yield sse_line

            done_payload = {'type': 'done', 'session_id': session_id}
            _apply_observability(done_payload, {
                'task_id': started.task_id,
                'session_id': session_id,
                'run_id': started.run_id,
                'execution_kind': 'agent_stream',
                'request_id': started.request_id or request_id,
            })
            yield _sse_line(done_payload)

        except Exception as e:
            logger.error('流式执行异常: session_id=%s request_id=%s error=%s', session_id, request_id, e, exc_info=True)
            yield _sse_line({'type': 'error', 'content': str(e), 'session_id': session_id})

    return StreamingResponse(event_generator(), media_type='text/event-stream')


@router.post('/stream/stop')
async def stream_stop(request: StreamStopRequest, http_request: Request):
    """停止正在执行的流式任务。"""
    try:
        execution_service = get_execution_service()
        interrupted = await asyncio.to_thread(
            lambda: execution_service.cancel_session(request.session_id, reason='user_stop')
        )
        if not interrupted:
            raise HTTPException(status_code=404, detail='该会话没有正在执行的任务')
        logger.info('已发送用户中断事件: session_id=%s', request.session_id)
        return ok(data={'interrupted': True})
    except HTTPException:
        raise
    except Exception as e:
        logger.error('停止流式任务失败: %s', e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/stream/reconnect')
async def stream_reconnect(request: StreamReconnectRequest, http_request: Request):
    """重连到正在执行的任务的 SSE 流。"""
    session_id = request.session_id
    request_id = _ensure_request_id(http_request.headers.get('X-Request-ID'))

    execution_service = get_execution_service()
    status = await asyncio.to_thread(execution_service.get_status_by_session, session_id)
    if not status or status.get('status') != 'running':
        raise HTTPException(status_code=404, detail='该会话没有正在执行的任务')

    run_started_at = status.get('started_at', 0)
    logger.info(
        '建立流式重连: session_id=%s task_id=%s run_id=%s request_id=%s',
        session_id, status.get('task_id'), status.get('run_id'),
        status.get('request_id') or request_id,
    )

    def _sse_line(payload: dict, **dumps_kwargs) -> str:
        return f"data: {json.dumps(payload, ensure_ascii=False, **dumps_kwargs)}\n\n"

    async def event_generator() -> AsyncGenerator[str, None]:
        try:
            from agents.events import SSEAdapter

            event_bus = get_session_event_bus(session_id)

            all_history = await asyncio.to_thread(
                event_bus.get_event_history, session_id=session_id, limit=1000
            )
            history = [e for e in all_history if getattr(e, 'timestamp', 0) >= run_started_at]

            reconnect_start = {
                'type': 'reconnect_start',
                'session_id': session_id,
                'replay_count': len(history),
            }
            _apply_observability(reconnect_start, {**status, 'request_id': status.get('request_id') or request_id})
            yield _sse_line(reconnect_start)

            for event in history:
                full_event = {
                    'type': event.type.value,
                    'event_id': getattr(event, 'event_id', None),
                    'timestamp': getattr(event, 'timestamp', None),
                    'priority': getattr(getattr(event, 'priority', None), 'value', None),
                    'session_id': getattr(event, 'session_id', None),
                    'trace_id': getattr(event, 'trace_id', None),
                    'span_id': getattr(event, 'span_id', None),
                    'agent_name': getattr(event, 'agent_name', None),
                    'call_id': getattr(event, 'call_id', None),
                    'parent_call_id': getattr(event, 'parent_call_id', None),
                    'data': event.data or {},
                    'requires_user_action': getattr(event, 'requires_user_action', False),
                    'user_action_timeout': getattr(event, 'user_action_timeout', None),
                }
                _apply_observability(full_event, event.data or {})
                yield _sse_line(full_event, default=str)

            reconnect_end = {'type': 'reconnect_end', 'session_id': session_id}
            _apply_observability(reconnect_end, {**status, 'request_id': status.get('request_id') or request_id})
            yield _sse_line(reconnect_end)

            adapter = SSEAdapter(
                event_bus=event_bus,
                session_id=session_id,
                buffer_size=100,
                heartbeat_interval=15.0,
            )
            adapter.start()

            queue: asyncio.Queue = asyncio.Queue()
            loop = asyncio.get_event_loop()

            async for sse_line in sync_to_async_sse(
                sync_stream=adapter.stream_sync,
                session_id=session_id,
            ):
                yield sse_line

            done_payload = {'type': 'done', 'session_id': session_id}
            _apply_observability(done_payload, {**status, 'request_id': status.get('request_id') or request_id})
            yield _sse_line(done_payload)

        except Exception as e:
            logger.error('重连流式执行异常: session_id=%s error=%s', session_id, e, exc_info=True)
            yield _sse_line({'type': 'error', 'content': str(e), 'session_id': session_id})

    return StreamingResponse(event_generator(), media_type='text/event-stream')


@router.post('/sessions/{session_id}/approvals/{approval_id}/respond')
async def respond_approval(session_id: str, approval_id: str, request: ApprovalRequest):
    """响应工具审批请求。"""
    from dependencies import get_task_registry
    registry = get_task_registry()
    ok_result = await asyncio.to_thread(
        registry.resolve_approval, session_id, approval_id, request.approved, request.message
    )
    if not ok_result:
        raise HTTPException(status_code=404, detail='未找到对应的审批请求，可能已超时或不存在')
    return ok(data={'approved': request.approved}, message='审批响应已提交')


@router.post('/sessions/{session_id}/inputs/{input_id}/respond')
async def respond_input(session_id: str, input_id: str, request: UserInputRequest):
    """提交用户输入。"""
    from dependencies import get_task_registry
    registry = get_task_registry()
    ok_result = await asyncio.to_thread(
        registry.resolve_input, session_id, input_id, request.value
    )
    if not ok_result:
        raise HTTPException(status_code=404, detail='未找到对应的输入请求，可能已被取消或不存在')
    return ok(data={'value': request.value}, message='用户输入已提交')
