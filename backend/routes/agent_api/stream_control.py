# -*- coding: utf-8 -*-
"""
Agent 流式控制与重连路由。
"""

from .shared import (
    EventType,
    Response,
    SSEAdapter,
    agent_bp,
    error_response,
    get_session_event_bus,
    get_task_registry,
    json,
    logger,
    request,
    stream_with_context,
    success_response,
)
from .stream_helpers import build_stream_response, format_event_to_sse

@agent_bp.route('/sessions/<session_id>/approvals/<approval_id>/respond', methods=['POST'])
def respond_approval(session_id, approval_id):
    """
    响应工具审批请求

    POST /api/agent/sessions/<session_id>/approvals/<approval_id>/respond
    Body: { "approved": true|false }
    """
    data = request.get_json() or {}
    approved = bool(data.get('approved', False))
    message = str(data.get('message', ''))

    registry = get_task_registry()
    ok = registry.resolve_approval(session_id, approval_id, approved, message)
    if not ok:
        return error_response(message='未找到对应的审批请求，可能已超时或不存在', status_code=404)

    return success_response(data={'approved': approved}, message='审批响应已提交')

@agent_bp.route('/sessions/<session_id>/inputs/<input_id>/respond', methods=['POST'])
def respond_input(session_id, input_id):
    """
    提交用户输入（响应 request_user_input 工具请求）

    POST /api/agent/sessions/<session_id>/inputs/<input_id>/respond
    Body: { "value": "用户输入的内容" }
    """
    data = request.get_json() or {}
    value = str(data.get('value', ''))

    registry = get_task_registry()
    ok = registry.resolve_input(session_id, input_id, value)
    if not ok:
        return error_response(message='未找到对应的输入请求，可能已被取消或不存在', status_code=404)

    return success_response(data={'value': value}, message='用户输入已提交')

@agent_bp.route('/stream/stop', methods=['POST'])
def stream_stop():
    """
    停止正在执行的流式任务

    Request:
        {
            "session_id": "会话ID"
        }

    Returns:
        {"interrupted": true}
    """
    try:
        data = request.get_json()
        session_id = data.get('session_id')

        if not session_id:
            return error_response(message='session_id 不能为空', status_code=400)

        event_bus = get_session_event_bus(session_id)
        from agents.events.bus import Event
        event_bus.publish(Event(
            type=EventType.USER_INTERRUPT,
            data={"reason": "user_stop"},
            session_id=session_id
        ))

        # ── 双重保障：直接设置 cancel_event ──
        registry = get_task_registry()
        registry.cancel(session_id)

        logger.info(f"已发送用户中断事件: session_id={session_id}")
        return success_response(data={"interrupted": True})

    except Exception as e:
        logger.error(f"停止流式任务失败: {e}", exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/stream/reconnect', methods=['POST'])
def stream_reconnect():
    """
    重连到正在执行的任务的 SSE 流。

    页面刷新后，前端检测到有运行中任务时调用此端点：
    1. 回放断开期间的事件历史
    2. 建立新 SSE 订阅接收后续事件

    Request:
        { "session_id": "会话ID" }

    Response:
        text/event-stream
        data: {"type": "reconnect_start", "replay_count": N, ...}
        data: ... (回放的历史事件)
        data: {"type": "reconnect_end", ...}
        data: ... (后续实时事件)
        data: {"type": "done", "session_id": "..."}
    """
    data = request.get_json()
    session_id = data.get('session_id')

    if not session_id:
        return error_response(message='session_id 不能为空', status_code=400)

    registry = get_task_registry()
    status = registry.get_status(session_id)
    if not status or status["status"] != "running":
        return error_response(message='该会话没有正在执行的任务', status_code=404)

    # 当前 run 的启动时间，用于过滤历史事件（只回放本次 run 的事件）
    run_started_at = status.get("started_at", 0)

    def generate():
        event_bus = get_session_event_bus(session_id)

        # 回放断开期间的事件历史（只回放当前 run 的事件，按时间戳过滤）
        all_history = event_bus.get_event_history(session_id=session_id, limit=1000)
        history = [e for e in all_history if getattr(e, 'timestamp', 0) >= run_started_at]

        # 先发 reconnect_start 告知前端即将回放
        yield f"data: {json.dumps({'type': 'reconnect_start', 'session_id': session_id, 'replay_count': len(history)}, ensure_ascii=False)}\n\n"

        for event in history:
            yield format_event_to_sse(event)

        # 回放结束标记
        yield f"data: {json.dumps({'type': 'reconnect_end', 'session_id': session_id}, ensure_ascii=False)}\n\n"

        # 建立新 SSE 订阅接收后续事件
        adapter = SSEAdapter(
            event_bus=event_bus,
            session_id=session_id,
            buffer_size=100,
            heartbeat_interval=15.0,
        )
        adapter.start()
        try:
            for sse_data in adapter.stream_sync():
                yield sse_data
        finally:
            pass  # adapter.stop() 在 stream_sync 的 finally 已调用

        yield f"data: {json.dumps({'type': 'done', 'session_id': session_id}, ensure_ascii=False)}\n\n"

    return build_stream_response(generate, Response, stream_with_context)
