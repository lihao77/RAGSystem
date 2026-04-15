# -*- coding: utf-8 -*-
"""
后台任务完成自动触发 Run。

对标 Claude Code 的 idle notification delivery：
当后台任务完成且 session 空闲时，自动发起系统 run，
让模型处理通知并把结果持久化到会话历史。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

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
            return  # 已有触发在等待
        _pending_triggers.add(session_id)

    def _delayed_check():
        try:
            # 给 run 内 drain 一个消费窗口
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

    # 队列已被 run 内 drain 消费？
    if not registry.peek_session_notifications(session_id):
        logger.debug('notification_trigger: session=%s 通知队列已空，跳过', session_id)
        return

    # session 是否空闲？
    if not registry.is_session_idle(session_id):
        logger.debug('notification_trigger: session=%s 有活跃 run，跳过', session_id)
        return

    # drain 通知，构建 task 输入
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
        # 把通知放回队列，下次重试
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
    """启动系统 run，立即推送 session.run_started 让前端实时订阅，后台 drain 清理 adapter。"""
    from runtime.container import get_current_runtime_container
    container = get_current_runtime_container()
    if not container:
        logger.warning('notification_trigger: RuntimeContainer 未初始化')
        return None

    runtime_svc = container.get_agent_api_runtime_service()

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

    if not started.started or started.sse_adapter is None:
        logger.warning(
            'notification_trigger: 系统 run 启动失败 session=%s error=%s',
            session_id, started.error_message,
        )
        return None

    run_id = started.run_id
    logger.info('notification_trigger: 系统 run 已启动 session=%s run_id=%s', session_id, run_id)

    # 立即通知前端有新 run 可订阅，前端通过 /stream/reconnect 获得实时流
    _push_event(session_id, {
        'type': 'session.run_started',
        'session_id': session_id,
        'run_id': run_id,
        'source': 'system.bg_notification',
        'notifications': [
            {
                'task_id': p.get('background_task_id') or p.get('task_id') or 'unknown',
                'status': p.get('status', 'completed'),
                'result_type': p.get('result_type'),
            }
            for p in notifications
        ],
    })

    # 后台 drain 原始 adapter（防止 event_bus 订阅泄漏）
    # run 完成后推送 session.updated 兜底（前端未及时连接时触发全量历史刷新）
    sse_adapter = started.sse_adapter

    def _drain_and_notify():
        try:
            for _ in sse_adapter.stream_sync():
                pass
            logger.info('notification_trigger: 系统 run 完成 session=%s run_id=%s', session_id, run_id)
        except Exception as exc:
            logger.debug('notification_trigger: drain 线程异常: %s', exc)
        finally:
            try:
                sse_adapter.stop()
            except Exception:
                pass
            # 兜底：前端若未连上实时流，session.updated 触发完整历史刷新
            _push_event(session_id, {
                'type': 'session.updated',
                'session_id': session_id,
                'run_id': run_id,
                'source': 'system.bg_notification',
            })

    threading.Thread(
        target=_drain_and_notify,
        daemon=True,
        name=f'bg-drain-{session_id[:8]}',
    ).start()
    return run_id


def _push_event(session_id: str, event: dict) -> None:
    """通过全局 EventBus 推送 session 级事件（线程安全）。"""
    event.setdefault('timestamp', time.time())
    try:
        from runtime.container import get_current_runtime_container
        container = get_current_runtime_container()
        if not container:
            return
        from agents.events import Event, EventType
        bus = container.get_event_bus()
        event_type = EventType(event['type'])
        bus.publish(Event(type=event_type, data=event, session_id=session_id))
    except Exception as exc:
        logger.debug('notification_trigger: push 事件失败: %s', exc)
