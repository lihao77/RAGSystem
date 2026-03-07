# -*- coding: utf-8 -*-
"""
Agent 主流式执行路由。
"""

from .shared import (
    AgentContext,
    ContextManager,
    Event,
    EventType,
    Message,
    Response,
    SSEAdapter,
    agent_bp,
    asyncio,
    error_response,
    get_config,
    get_session_event_bus,
    get_task_registry,
    json,
    logger,
    request,
    stream_with_context,
    success_response,
    uuid_module,
    _get_conversation_store,
    _get_orchestrator,
    _load_history_into_context,
)
from .stream_helpers import (
    build_stream_response,
    create_agent_thread_target,
    create_stream_subscriptions,
    parse_selected_llm,
)

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
    data = request.get_json()
    task = data.get('task', '').strip()
    session_id = data.get('session_id')
    user_id = data.get('user_id')
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
        # ── 并发拒绝：同一 session 不允许同时执行多个任务 ──
        registry = get_task_registry()
        pre_status = registry.get_status(session_id)
        if pre_status and pre_status["status"] == "running":
            yield f"data: {json.dumps({'type': 'error', 'content': '该会话正在执行任务，请等待完成或停止当前任务'}, ensure_ascii=False)}\n\n"
            return

        try:
            store = _get_conversation_store()
            store.create_session(session_id=session_id, user_id=user_id)

            # 获取 Orchestrator
            orchestrator = _get_orchestrator()

            # 创建上下文（含前端选择的 LLM 覆盖）
            context = AgentContext(session_id=session_id, user_id=user_id, llm_override=llm_override)
            _load_history_into_context(context, session_id=session_id, limit=50)

            # 生成 run_id 并注入 context，用于中间过程落库与关联 assistant 消息
            run_id = str(uuid_module.uuid4())
            context.metadata['run_id'] = run_id

            # 创建 cancel_event 用于用户中断
            import threading as _threading
            cancel_event = _threading.Event()
            context.metadata['cancel_event'] = cancel_event

            # 统一入口：MasterAgent V2
            master_agent = orchestrator.agents.get('master_agent_v2')
            if not master_agent:
                yield f"data: {json.dumps({'type': 'error', 'content': 'MasterAgent 未找到，请确认已正确加载'}, ensure_ascii=False)}\n\n"
                return

            # ✨ 获取会话级事件总线
            event_bus = get_session_event_bus(session_id)

            # ✨ 让 MetricsCollector 订阅此会话的事件总线
            metrics_collector = getattr(orchestrator, '_metrics_collector', None)
            metrics_subscription_id = None
            if metrics_collector:
                metrics_subscription_id = metrics_collector.subscribe_to_events(event_bus)
                logger.info(f"✓ MetricsCollector 已订阅会话 {session_id} 的事件总线")

            # ✨ 创建 SSEAdapter（纯转发管道，不含业务逻辑）
            adapter = SSEAdapter(
                event_bus=event_bus,
                session_id=session_id,
                buffer_size=100,
                heartbeat_interval=15.0,
            )

            import threading
            final_answer_saved = threading.Event()
            message_id_for_run = [None]

            subscriptions = create_stream_subscriptions(
                event_bus=event_bus,
                store=store,
                registry=registry,
                session_id=session_id,
                run_id=run_id,
                cancel_event=cancel_event,
                final_answer_saved=final_answer_saved,
                message_id_for_run=message_id_for_run,
            )

            user_msg = store.add_message(session_id=session_id, role="user", content=task, metadata={"agent": "master_agent_v2"})

            execute_agent_task = create_agent_thread_target(
                event_bus=event_bus,
                final_answer_saved=final_answer_saved,
                master_agent=master_agent,
                registry=registry,
                run_id=run_id,
                session_id=session_id,
                store=store,
                task=task,
                context=context,
                user_message=user_msg,
            )

            # ✨ 先启动 SSEAdapter 订阅，再启动 Agent 线程，避免早期事件丢失
            adapter.start()

            # 启动后台线程执行 Agent
            thread = threading.Thread(target=execute_agent_task, daemon=True)
            thread.start()

            # ── 注册到 TaskRegistry（线程启动后注册，确保 thread 对象有效）──
            if not registry.register(session_id, run_id, task, thread, cancel_event):
                cancel_event.set()
                yield f"data: {json.dumps({'type': 'error', 'content': '该会话正在执行另一任务'}, ensure_ascii=False)}\n\n"
                return

            # ── 将持久化订阅 ID 存入 TaskInfo，由 Agent 线程结束时清理 ──
            persistent_sub_ids = [
                subscriptions['run_steps'],
                subscriptions['persist_final_answer'],
                subscriptions['compression'],
                subscriptions['react_intermediate'],
                subscriptions['interrupt'],
            ]
            if metrics_subscription_id:
                persistent_sub_ids.append(metrics_subscription_id)
            registry.set_persistent_subscriptions(session_id, persistent_sub_ids, event_bus)

            # ✨ 从事件总线流式输出（SSEAdapter 内部管理 stop 生命周期）
            # SSE 断开时只清理 adapter，不取消 Agent 线程，不清理持久化订阅
            try:
                for sse_data in adapter.stream_sync():
                    yield sse_data
            finally:
                # SSE 断开：只清理过期记录，不取消 Agent
                registry.cleanup_finished()

            # 结束事件
            yield f"data: {json.dumps({'type': 'done', 'session_id': session_id}, ensure_ascii=False)}\n\n"

        except Exception as e:
            logger.error(f"流式执行异常: {e}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)}, ensure_ascii=False)}\n\n"

    return build_stream_response(generate, Response, stream_with_context)
