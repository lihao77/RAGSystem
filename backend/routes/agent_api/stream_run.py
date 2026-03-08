# -*- coding: utf-8 -*-
"""
Agent 主流式执行路由。
"""

from .shared import (
    Response,
    agent_bp,
    error_response,
    json,
    logger,
    request,
    stream_with_context,
    _get_conversation_store,
    _get_orchestrator,
    _load_history_into_context,
)
from .stream_helpers import build_stream_response, parse_selected_llm
from execution.observability import apply_observability_fields, ensure_request_id
from execution.adapters.agent_execution import AgentExecutionAdapter

@agent_bp.route('/stream', methods=['POST'])
def stream_execute():
    """
    流式执行智能体任务（Server-Sent Events）- 使用事件总线解耦

    Request:
        {
            "task": "任务描述",
            "session_id": "会话ID（可选）",
            "selected_llm": "provider|provider_type|model_name（可选，前端 llm-select-trigger 选择，用于临时覆盖默认/未配置 LLM 的智能体）"
        }

    Response:
        text/event-stream
        data: {"type": "thought", "content": "..."}
        data: {"type": "agent_start", "agent": "qa_agent", "content": "..."}
        data: {"type": "chunk", "content": "部分回答..."}
        data: {"type": "done", "session_id": "..."}
    """
    data = request.get_json() or {}
    task = data.get('task', '').strip()
    session_id = data.get('session_id')
    user_id = data.get('user_id')
    request_id = ensure_request_id(request.headers.get('X-Request-ID'))
    # 前端 llm-select-trigger 选择：格式 "provider|provider_type|model_name"，用于临时覆盖默认/未配置 LLM 的智能体
    selected_llm = (data.get('selected_llm') or data.get('selectedLLM') or '').strip()
    llm_override = parse_selected_llm(selected_llm)
    if llm_override:
        logger.info(f'流式请求使用前端选择 LLM: selected_llm={selected_llm!r} -> llm_override={llm_override}')
    else:
        logger.info('流式请求未携带 selected_llm，将使用系统/智能体默认 LLM')

    if not task:
        return error_response(message='任务描述不能为空', status_code=400)

    # 生成 session_id（如果未提供）
    if not session_id:
        import uuid
        session_id = str(uuid.uuid4())

    logger.info(f'流式执行任务: {task} (session_id: {session_id})')

    def generate():
        try:
            started = AgentExecutionAdapter().start_stream_execution(
                task=task,
                session_id=session_id,
                user_id=user_id,
                llm_override=llm_override,
                request_id=request_id,
                conversation_store=_get_conversation_store(),
                orchestrator=_get_orchestrator(),
                history_loader=_load_history_into_context,
            )
            if not started.started or started.sse_adapter is None:
                error_payload = {
                    'type': 'error',
                    'content': started.error_message or '启动流式任务失败',
                    'session_id': session_id,
                }
                apply_observability_fields(error_payload, {
                    'task_id': started.task_id,
                    'session_id': session_id,
                    'run_id': started.run_id,
                    'execution_kind': 'agent_stream',
                    'request_id': started.request_id or request_id,
                })
                yield f"data: {json.dumps(error_payload, ensure_ascii=False)}\n\n"
                return

            try:
                for sse_data in started.sse_adapter.stream_sync():
                    yield sse_data
            finally:
                from services.execution_service import get_execution_service
                get_execution_service().cleanup_finished()

            done_payload = {'type': 'done', 'session_id': session_id}
            apply_observability_fields(done_payload, {
                'task_id': started.task_id,
                'session_id': session_id,
                'run_id': started.run_id,
                'execution_kind': 'agent_stream',
                'request_id': started.request_id or request_id,
            })
            yield f"data: {json.dumps(done_payload, ensure_ascii=False)}\n\n"

        except Exception as e:
            logger.error(f"流式执行异常: {e}", exc_info=True)
            error_payload = {'type': 'error', 'content': str(e), 'session_id': session_id}
            apply_observability_fields(error_payload, {
                'session_id': session_id,
                'execution_kind': 'agent_stream',
                'request_id': request_id,
            })
            yield f"data: {json.dumps(error_payload, ensure_ascii=False)}\n\n"

    return build_stream_response(generate, Response, stream_with_context)
