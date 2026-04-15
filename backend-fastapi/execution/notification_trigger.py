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
        _start_system_run(session_id, task_text)
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


def _start_system_run(session_id: str, task: str) -> Optional[str]:
    """启动系统 run 并同步等待完成。复用 daemon 的 consume_stream 模式。"""
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

    # 同步消费 SSE 流直到 run 结束（消息由 StreamPersistenceHandler 自动持久化）
    from daemon.utils import consume_stream
    try:
        result = consume_stream(started.sse_adapter)
        logger.info('notification_trigger: 系统 run 完成 session=%s', session_id)
        return result
    finally:
        try:
            started.sse_adapter.stop()
        except Exception:
            pass
