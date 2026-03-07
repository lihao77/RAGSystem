# -*- coding: utf-8 -*-
"""
Agent 流式执行辅助函数。
"""

import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

from .shared import Event, EventType, json, logger


def parse_selected_llm(selected_llm: str) -> Optional[Dict[str, Optional[str]]]:
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


def make_payload_safe(data: Any) -> Dict[str, Any]:
    """确保 payload 可 JSON 序列化。"""
    if data is None:
        return {}
    if not isinstance(data, dict):
        return {'value': str(data)}

    safe_data: Dict[str, Any] = {}
    for key, value in data.items():
        try:
            json.dumps(value, ensure_ascii=False)
            safe_data[key] = value
        except (TypeError, ValueError):
            safe_data[key] = str(value)
    return safe_data


def event_to_payload(event) -> Dict[str, Any]:
    payload = {
        'type': event.type.value,
        'event_id': getattr(event, 'event_id', None),
        'timestamp': getattr(event, 'timestamp', None),
        'priority': getattr(getattr(event, 'priority', None), 'value', None),
        'session_id': getattr(event, 'session_id', None),
        'trace_id': getattr(event, 'trace_id', None),
        'span_id': getattr(event, 'span_id', None),
        'agent_name': event.agent_name,
        'call_id': getattr(event, 'call_id', None),
        'parent_call_id': getattr(event, 'parent_call_id', None),
        'data': make_payload_safe(event.data),
        'requires_user_action': getattr(event, 'requires_user_action', False),
        'user_action_timeout': getattr(event, 'user_action_timeout', None),
    }
    if event.type in (EventType.CALL_AGENT_START, EventType.CALL_AGENT_END):
        called = (event.data or {}).get('agent_name')
        if called is not None:
            payload['agent_name'] = called
    return payload


def format_event_to_sse(event) -> str:
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
    json_data = json.dumps(full_event, ensure_ascii=False, default=str)
    return f"data: {json_data}\n\n"


def create_stream_subscriptions(*, event_bus, store, registry, session_id: str, run_id: str, cancel_event, final_answer_saved, message_id_for_run: List[Optional[int]]):
    def handle_user_interrupt(event):
        logger.info(f'收到用户中断事件: session_id={session_id}')
        cancel_event.set()

    interrupt_subscription_id = event_bus.subscribe(
        event_types=[EventType.USER_INTERRUPT],
        handler=handle_user_interrupt,
        filter_func=lambda event: event.session_id == session_id,
    )

    def handle_compression_summary(event):
        try:
            data = event.data or {}
            content = data.get('content')
            event_session_id = data.get('session_id') or event.session_id
            replaces_up_to_seq = data.get('replaces_up_to_seq')
            if content and event_session_id:
                store.insert_compression_message(
                    session_id=event_session_id,
                    summary_content=content,
                    replaces_up_to_seq=replaces_up_to_seq,
                )
                logger.info(f'已保存压缩摘要到 DB: session_id={event_session_id}, replaces_up_to_seq={replaces_up_to_seq}')
        except Exception as error:
            logger.warning(f'保存压缩摘要失败: {error}', exc_info=True)

    compression_subscription_id = event_bus.subscribe(
        event_types=[EventType.COMPRESSION_SUMMARY],
        handler=handle_compression_summary,
        filter_func=lambda event: event.session_id == session_id,
    )

    def handle_react_intermediate(event):
        try:
            data = event.data or {}
            store.add_message(
                session_id=session_id,
                role=data.get('role', 'assistant'),
                content=data.get('content', ''),
                metadata={
                    'react_intermediate': True,
                    'msg_type': data.get('msg_type'),
                    'round': data.get('round'),
                    'run_id': run_id,
                    'agent': 'master_agent_v2',
                },
            )
        except Exception as error:
            logger.warning(f'写入 react_intermediate 消息失败: {error}', exc_info=True)

    react_intermediate_subscription_id = event_bus.subscribe(
        event_types=[EventType.REACT_INTERMEDIATE],
        handler=handle_react_intermediate,
        filter_func=lambda event: event.session_id == session_id,
    )

    def handle_final_answer_persist(event):
        if event.agent_name and event.agent_name != 'master_agent_v2':
            return
        if final_answer_saved.is_set():
            return
        content = (event.data or {}).get('content')
        if content is None:
            return
        try:
            message = store.add_message(
                session_id=session_id,
                role='assistant',
                content=content if isinstance(content, str) else str(content),
                metadata={'agent': event.agent_name, 'run_id': run_id},
            )
            message_id_for_run[0] = message['id']
            store.update_run_steps_message_id(session_id, run_id, message['id'])
            final_answer_saved.set()
            event_bus.publish(Event(
                type=EventType.MESSAGE_SAVED,
                data={'id': message['id'], 'seq': message.get('seq'), 'role': 'assistant'},
                session_id=session_id,
                agent_name=event.agent_name,
            ))
        except Exception as error:
            logger.warning(f'写入 assistant 消息失败: {error}', exc_info=True)

    persist_subscription_id = event_bus.subscribe(
        event_types=[EventType.FINAL_ANSWER],
        handler=handle_final_answer_persist,
        filter_func=lambda event: event.session_id == session_id,
        priority=10,
    )

    step_event_types = [
        EventType.RUN_START,
        EventType.AGENT_START,
        EventType.THINKING_COMPLETE,
        EventType.CALL_AGENT_START,
        EventType.CALL_AGENT_END,
        EventType.CALL_TOOL_START,
        EventType.CALL_TOOL_END,
        EventType.CHART_GENERATED,
        EventType.MAP_GENERATED,
        EventType.RUN_END,
    ]

    def handle_step_and_final_answer(event):
        payload = event_to_payload(event)
        try:
            store.add_run_step(
                session_id=session_id,
                run_id=run_id,
                step_type=event.type.value,
                payload=payload,
                message_id=None,
            )
        except Exception as error:
            logger.warning(f'写入 run_step 失败: {error}', exc_info=True)
        if event.type == EventType.RUN_END and message_id_for_run[0]:
            try:
                store.update_run_steps_message_id(session_id, run_id, message_id_for_run[0])
            except Exception as error:
                logger.warning(f'RUN_END 时更新 run_steps message_id 失败: {error}', exc_info=True)

    run_step_subscription_id = event_bus.subscribe(
        event_types=step_event_types,
        handler=handle_step_and_final_answer,
        filter_func=lambda event: event.session_id == session_id,
    )

    return {
        'interrupt': interrupt_subscription_id,
        'compression': compression_subscription_id,
        'react_intermediate': react_intermediate_subscription_id,
        'persist_final_answer': persist_subscription_id,
        'run_steps': run_step_subscription_id,
    }


def create_agent_thread_target(*, event_bus, final_answer_saved, master_agent, registry, run_id: str, session_id: str, store, task: str, context, user_message):
    def execute_agent_task():
        try:
            event_bus.publish(Event(
                type=EventType.MESSAGE_SAVED,
                data={'id': user_message['id'], 'seq': user_message.get('seq'), 'role': 'user'},
                session_id=session_id,
                agent_name='master_agent_v2',
            ))
            logger.info(f'后台执行 Agent 任务: {task}')
            response = master_agent.execute(task, context)
            if response and getattr(response, 'content', None) and not final_answer_saved.is_set():
                message = store.add_message(
                    session_id=session_id,
                    role='assistant',
                    content=response.content,
                    metadata={'agent': getattr(response, 'agent_name', None), 'run_id': run_id},
                )
                store.update_run_steps_message_id(session_id, run_id, message['id'])
                final_answer_saved.set()
            logger.info(f'Agent 任务执行完成: {task}')
            registry.unregister(session_id, 'completed')
        except Exception as error:
            logger.error(f'后台执行 Agent 失败: {error}', exc_info=True)
            registry.unregister(session_id, 'failed')
            from agents.events import EventPublisher
            publisher = EventPublisher(
                agent_name='system',
                session_id=session_id,
                event_bus=event_bus,
            )
            publisher.agent_error(error=str(error), error_type='ExecutionError')
        finally:
            registry.cleanup_subscriptions(session_id)

    return execute_agent_task


def build_stream_response(generate: Callable[[], Any], response_class, stream_with_context_func):
    response = response_class(stream_with_context_func(generate()), mimetype='text/event-stream')
    response.headers['Content-Type'] = 'text/event-stream; charset=utf-8'
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['X-Accel-Buffering'] = 'no'
    return response
