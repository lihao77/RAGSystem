# -*- coding: utf-8 -*-
"""
后台任务完成自动触发 Run。

当后台任务完成且 session 空闲时，自动发起系统 run。
事件通过 EventBus 自然流转到 WebSocket 连接。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

from agents.events.bus import Event, EventType

logger = logging.getLogger(__name__)

# 防止同一 session 并发触发多个自动 run
_pending_triggers: set[str] = set()
_trigger_lock = threading.Lock()


def try_auto_trigger(session_id: str) -> None:
    """在后台线程中延迟检查并触发自动 run（非阻塞入口）。"""
    if not session_id:
        return
    with _trigger_lock:
        if session_id in _pending_triggers:
            return
        _pending_triggers.add(session_id)

    def _delayed_check():
        try:
            time.sleep(1.0)
            _do_auto_run(session_id)
        finally:
            with _trigger_lock:
                _pending_triggers.discard(session_id)

    threading.Thread(target=_delayed_check, daemon=True, name=f'bg-notify-{session_id[:8]}').start()


def _do_auto_run(session_id: str) -> None:
    """检查条件并执行自动 run。"""
    try:
        from agents.task_registry import get_task_registry
        registry = get_task_registry()
    except Exception:
        logger.debug('notification_trigger: TaskRegistry 不可用，跳过')
        return

    if not registry.peek_session_notifications(session_id):
        logger.debug('notification_trigger: session=%s 通知队列已空，跳过', session_id)
        return

    if not registry.is_session_idle(session_id):
        logger.debug('notification_trigger: session=%s 有活跃 run，跳过', session_id)
        return

    notifications = registry.drain_session_notifications(session_id)
    if not notifications:
        return

    task_parts = []
    for payload in notifications:
        task_parts.append(_build_notification_xml(payload))
    task_text = '\n\n'.join(task_parts)

    logger.info(
        'notification_trigger: 自动触发系统 run session=%s notifications=%d',
        session_id, len(notifications),
    )

    try:
        _start_system_run(session_id, task_text, notifications)
    except Exception as exc:
        logger.warning('notification_trigger: 自动 run 失败 session=%s error=%s', session_id, exc)
        for payload in notifications:
            try:
                registry.add_session_notification(session_id, payload)
            except Exception:
                pass


def _build_notification_xml(payload: dict) -> str:
    """构建 <task-notification> XML。"""
    task_id = payload.get('background_task_id') or payload.get('task_id') or 'unknown'
    status = payload.get('status', 'completed')
    output_path = payload.get('output_path') or ''
    return_code = payload.get('return_code')
    result_type = payload.get('result_type')
    summary = payload.get('summary') or payload.get('description') or ''

    parts = ['<task-notification>']
    parts.append(f'<task-id>{task_id}</task-id>')
    if output_path:
        parts.append(f'<output-file>{output_path}</output-file>')
    parts.append(f'<status>{status}</status>')
    if return_code is not None:
        parts.append(f'<return-code>{return_code}</return-code>')
    if result_type:
        parts.append(f'<result-type>{result_type}</result-type>')
    if summary:
        parts.append(f'<summary>{summary}</summary>')
    parts.append('</task-notification>')
    return '\n'.join(parts)


def _start_system_run(session_id: str, task: str, notifications: list[dict]) -> Optional[str]:
    """启动系统 run。事件通过 EventBus 自然流转到 WebSocket。"""
    from runtime.container import get_current_runtime_container
    container = get_current_runtime_container()
    if not container:
        logger.warning('notification_trigger: RuntimeContainer 未初始化')
        return None

    runtime_svc = container.get_agent_api_runtime_service()
    global_bus = container.get_event_bus()

    from execution.adapters.agent_execution import AgentExecutionAdapter
    adapter = AgentExecutionAdapter(
        execution_service=container.get_execution_service(),
        agent_execution_service=runtime_svc.get_agent_execution_service(),
    )

    started = adapter.start_stream_execution(
        task=task,
        session_id=session_id,
        user_id=None,
        llm_override=None,
        llm_tier=None,
        request_id=None,
        conversation_store=runtime_svc.get_conversation_store(),
        orchestrator=runtime_svc.create_execution_orchestrator(session_id=session_id),
        history_loader=None,
        source='system.bg_notification',
    )

    if not started.started:
        logger.warning(
            'notification_trigger: 系统 run 启动失败 session=%s error=%s',
            session_id, started.error_message,
        )
        return None

    run_id = started.run_id
    logger.info('notification_trigger: 系统 run 已启动 session=%s run_id=%s', session_id, run_id)

    try:
        global_bus.publish(Event(
            type=EventType.SESSION_RUN_STARTED,
            data={
                'run_id': run_id,
                'source': 'system.bg_notification',
                'notifications': notifications,
            },
            session_id=session_id,
        ))
    except Exception as exc:
        logger.debug('notification_trigger: 发布 session.run_started 失败: %s', exc)

    # 注册 RUN_END 回调进行资源清理（替代原来的 drain 线程）
    from agents.events.session_manager import get_session_manager
    run_event_bus = get_session_manager().get_or_create(run_id, session_id=session_id)

    def _on_run_end(event: Event):
        logger.info('notification_trigger: 系统 run 完成 session=%s run_id=%s', session_id, run_id)
        from execution.cleanup import cleanup_after_run
        cleanup_after_run(session_id, run_id)
        try:
            global_bus.publish(Event(
                type=EventType.SESSION_UPDATED,
                data={'run_id': run_id, 'source': 'system.bg_notification'},
                session_id=session_id,
            ))
        except Exception:
            pass

    run_event_bus.subscribe(
        [EventType.RUN_END],
        _on_run_end,
        filter_func=lambda e: bool(e.session_id) and e.session_id == session_id,
    )

    return run_id
