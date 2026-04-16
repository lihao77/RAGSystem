# -*- coding: utf-8 -*-
"""
Agent 流式执行 API 路由。

内容交付已迁移到 WebSocket（ws.py），此模块仅负责：
- POST /stream：启动执行，返回 JSON
- POST /stream/stop：停止执行
- 审批/输入响应端点
"""

import asyncio
import json
import logging
import threading
import uuid
from typing import Dict

from fastapi import APIRouter, HTTPException, Request

from dependencies import get_execution_service
from schemas.execution import StreamExecuteRequest, StreamStopRequest, ApprovalRequest, UserInputRequest
from schemas.common import ok
import commands as cmd_mod

logger = logging.getLogger(__name__)
router = APIRouter()

# 跟踪正在执行的系统命令的取消事件（session_id → cancel_event）
_active_system_commands: Dict[str, threading.Event] = {}


def has_active_system_command(session_id: str) -> bool:
    """检查指定会话是否有正在执行的系统命令（如 /compact）。"""
    return session_id in _active_system_commands


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


def _parse_llm_tier(llm_tier: str):
    normalized = (llm_tier or '').strip().lower()
    return normalized or None


def _build_attachment_records(attachments) -> list[dict]:
    return [
        {
            'file_id': item.file_id,
            'original_name': item.original_name,
            'stored_name': item.stored_name,
            'mime': item.mime,
            'size': item.size,
            'kind': item.kind,
        }
        for item in (attachments or [])
    ]


def _validate_session_attachments(session_id: str, attachments: list[dict]) -> list[dict]:
    if not attachments:
        return []
    from dependencies import get_file_index
    index = get_file_index()
    validated = []
    for item in attachments:
        file_id = (item.get('file_id') or '').strip()
        if not file_id:
            raise HTTPException(status_code=400, detail='附件 file_id 不能为空')
        record = index.get(file_id, scope_type='session', scope_id=session_id)
        if not record:
            raise HTTPException(status_code=400, detail=f'附件不存在或不属于当前会话: {file_id}')
        validated.append({
            'file_id': record.get('id') or file_id,
            'original_name': record.get('original_name'),
            'stored_name': record.get('stored_name'),
            'stored_path': record.get('stored_path'),
            'mime': record.get('mime') or item.get('mime') or '',
            'size': record.get('size') or item.get('size'),
            'kind': item.get('kind') or ('image' if str(record.get('mime') or '').startswith('image/') else 'file'),
        })
    return validated


def _ensure_request_id(request_id=None) -> str:
    try:
        from execution.observability import ensure_request_id
        return ensure_request_id(request_id)
    except Exception:
        return request_id or str(uuid.uuid4())[:8]


def _drain_sse_adapter_background(sse_adapter, session_id: str, run_id: str):
    """后台线程消费 SSEAdapter 防止 queue 溢出，run 结束后清理资源。"""
    from execution.cleanup import cleanup_after_run

    def _drain():
        try:
            for _ in sse_adapter.stream_sync():
                pass
        except Exception as exc:
            logger.debug('drain SSEAdapter 异常 session=%s: %s', session_id, exc)
        finally:
            try:
                sse_adapter.stop()
            except Exception:
                pass
            cleanup_after_run(session_id, run_id)

    threading.Thread(target=_drain, daemon=True, name=f'drain-{session_id[:8]}').start()


def _publish_command_result(session_id: str, result: dict):
    """通过 EventBus 推送斜杠命令结果（WebSocket 会收到）。"""
    try:
        from runtime.container import get_current_runtime_container
        from agents.events.bus import Event, EventType
        container = get_current_runtime_container()
        if not container:
            return
        bus = container.get_event_bus()
        bus.publish(Event(
            type=EventType.COMMAND_RESULT,
            data=result,
            session_id=session_id,
        ))
    except Exception as exc:
        logger.debug('推送命令结果失败: %s', exc)


async def _execute_system_command_async(session_id: str, cmd_name: str, cmd_args: str, task: str, defn, llm_override):
    """异步执行系统命令，结果通过 EventBus → WebSocket 推送。"""
    cancel_event = threading.Event()
    _active_system_commands[session_id] = cancel_event
    try:
        # 通知前端命令已开始执行（用于延长 fallback 超时）
        _publish_command_result(session_id, {
            'command': cmd_name.lstrip('/'), 'type': 'command.started',
        })

        # 持久化用户命令消息
        try:
            from dependencies import get_agent_runtime_service
            store = get_agent_runtime_service().get_conversation_store()
            store.add_message(
                session_id=session_id, role='user', content=task,
                metadata={'type': 'command', 'command': cmd_name.lstrip('/')},
            )
        except Exception as persist_err:
            logger.warning('命令消息持久化失败: %s', persist_err)

        # 执行命令
        try:
            result = await defn.handler(session_id, cmd_args, selected_llm=llm_override, cancel_event=cancel_event)
        except Exception as e:
            logger.error('命令执行失败: %s', e, exc_info=True)
            result = {'command': cmd_name.lstrip('/'), 'success': False, 'content': f'执行失败: {e}'}

        if cancel_event.is_set():
            result = {'command': cmd_name.lstrip('/'), 'success': False, 'content': '操作已被用户中断'}

        # 持久化命令结果
        try:
            from dependencies import get_agent_runtime_service
            store = get_agent_runtime_service().get_conversation_store()
            store.add_message(
                session_id=session_id, role='system', content=result.get('content', ''),
                metadata={
                    'type': 'command_result',
                    'command': result.get('command', cmd_name.lstrip('/')),
                    'success': result.get('success', False),
                },
            )
        except Exception as persist_err:
            logger.warning('命令结果持久化失败: %s', persist_err)

        # 通过 EventBus 推送结果到 WebSocket
        _publish_command_result(session_id, result)
    finally:
        _active_system_commands.pop(session_id, None)


@router.post('/stream')
async def stream_execute(request: StreamExecuteRequest, http_request: Request):
    """
    启动智能体任务执行。

    返回 JSON，内容通过 WebSocket 实时推送。
    """
    task = request.task.strip()
    session_id = request.session_id or str(uuid.uuid4())
    user_id = request.user_id
    request_id = _ensure_request_id(http_request.headers.get('X-Request-ID'))
    selected_llm_str = request.selected_llm or ''
    llm_override = _parse_selected_llm(selected_llm_str)
    llm_tier = _parse_llm_tier(request.llm_tier or '')

    # ── 斜杠命令预处理 ──
    display_task = None
    if task.startswith('/'):
        parsed = cmd_mod.parse_slash_command(task)
        if parsed is not None:
            if parsed.defn is None:
                # 未知命令：直接通过 EventBus 推送错误
                _publish_command_result(session_id, {
                    'command': parsed.cmd_name.lstrip('/'), 'success': False,
                    'content': f'未知命令: {parsed.cmd_name}\n输入 /help 查看可用命令',
                })
                return ok(data={
                    'started': False, 'session_id': session_id,
                    'kind': 'command', 'command': parsed.cmd_name.lstrip('/'),
                })
            if parsed.defn.mode == 'system':
                # 异步执行系统命令，结果通过 WS 推送
                def _log_cmd_exc(fut):
                    if not fut.cancelled() and fut.exception():
                        logger.error('系统命令异步执行失败 session=%s cmd=%s: %s',
                                     session_id, parsed.cmd_name, fut.exception())
                t = asyncio.create_task(
                    _execute_system_command_async(
                        session_id, parsed.cmd_name, parsed.args, task, parsed.defn, llm_override,
                    )
                )
                t.add_done_callback(_log_cmd_exc)
                return ok(data={
                    'started': True, 'session_id': session_id,
                    'kind': 'command', 'command': parsed.cmd_name.lstrip('/'),
                })
            # prompt 命令：展开模板，走正常 agent run
            if not parsed.args.strip():
                _publish_command_result(session_id, {
                    'command': parsed.cmd_name.lstrip('/'), 'success': False,
                    'error': 'missing_args',
                    'content': f'用法: {parsed.cmd_name} <内容>\n{parsed.defn.description}',
                })
                return ok(data={
                    'started': False, 'session_id': session_id,
                    'kind': 'command', 'command': parsed.cmd_name.lstrip('/'),
                })
            display_task = task
            task = parsed.defn.template.replace('{args}', parsed.args)

    attachment_records = _validate_session_attachments(session_id, _build_attachment_records(request.attachments))
    if not task and not attachment_records:
        raise HTTPException(status_code=400, detail='任务描述和附件不能同时为空')

    logger.info('启动执行任务: session_id=%s request_id=%s task=%s attachments=%s', session_id, request_id, task, len(attachment_records))

    # ── 启动 Agent 执行 ──
    from execution.adapters.agent_execution import AgentExecutionAdapter
    from dependencies import get_agent_runtime_service

    runtime = get_agent_runtime_service()

    def _start():
        return AgentExecutionAdapter().start_stream_execution(
            task=task,
            session_id=session_id,
            user_id=user_id,
            llm_override=llm_override,
            llm_tier=llm_tier,
            request_id=request_id,
            conversation_store=runtime.get_conversation_store(),
            orchestrator=runtime.create_execution_orchestrator(session_id=session_id),
            history_loader=runtime.load_history_into_context,
            current_attachments=attachment_records,
            display_task=display_task,
        )

    started = await asyncio.to_thread(_start)

    if not started.started:
        raise HTTPException(status_code=409, detail=started.error_message or '启动执行失败')

    # SSEAdapter 后台 drain（防 queue 溢出 + run 结束后清理资源）
    if started.sse_adapter:
        _drain_sse_adapter_background(started.sse_adapter, session_id, started.run_id or '')

    return ok(data={
        'started': True,
        'session_id': session_id,
        'run_id': started.run_id,
        'task_id': started.task_id,
        'request_id': started.request_id or request_id,
        'kind': 'agent_run',
    })


@router.post('/stream/stop')
async def stream_stop(request: StreamStopRequest, http_request: Request):
    """停止正在执行的流式任务（含系统命令）。"""
    # 优先检查系统命令（如 /compact）
    sys_cancel = _active_system_commands.get(request.session_id)
    if sys_cancel is not None:
        sys_cancel.set()
        logger.info('已中断系统命令: session_id=%s', request.session_id)
        return ok(data={'interrupted': True})
    # 再走 agent 任务取消流程
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
