# -*- coding: utf-8 -*-
"""
Agent 流式执行适配器。
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from agents import AgentContext
from agents.core.models import AgentResponse
from agents.events import EventPublisher, EventType, SSEAdapter
from agents.events.bus import Event
from execution import ExecutionRequest, ExecutionResult, ExecutionStatus
from execution.observability import apply_observability_fields, attach_execution_metadata
from execution.persistence import StreamPersistenceHandler
from services.execution_service import ExecutionService, get_execution_service

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class AgentStreamStartResult:
    started: bool
    session_id: str
    run_id: Optional[str] = None
    task_id: Optional[str] = None
    request_id: Optional[str] = None
    sse_adapter: Optional[SSEAdapter] = None
    error_message: Optional[str] = None
    handle: Any = None


class AgentExecutionAdapter:
    """负责发起 Agent 流式执行任务。"""

    def __init__(self, execution_service: Optional[ExecutionService] = None):
        self._execution_service = execution_service or get_execution_service()

    def start_stream_execution(
        self,
        *,
        task: str,
        session_id: str,
        user_id: Optional[str],
        llm_override: Optional[Dict[str, Optional[str]]],
        request_id: Optional[str],
        conversation_store,
        orchestrator,
        history_loader: Callable[[AgentContext, str, int], None],
        history_limit: int = 50,
    ) -> AgentStreamStartResult:
        registry = self._execution_service.get_task_registry()
        session_manager = self._execution_service.get_session_manager()

        context = AgentContext(session_id=session_id, user_id=user_id, llm_override=llm_override)

        run_id = str(uuid.uuid4())
        context.metadata['run_id'] = run_id
        context.metadata['request_id'] = request_id

        cancel_event = threading.Event()
        context.metadata['cancel_event'] = cancel_event

        entry_agent = orchestrator.resolve_default_entry_agent() if hasattr(orchestrator, 'resolve_default_entry_agent') else None
        if not entry_agent:
            return AgentStreamStartResult(
                started=False,
                session_id=session_id,
                request_id=request_id,
                error_message='默认入口智能体未找到，请确认已正确加载',
            )

        event_bus = session_manager.get_or_create(session_id)
        context.metadata['event_bus'] = event_bus
        concurrency_key = f'session:{session_id}'
        task_id = registry.register_task(
            session_id=session_id,
            run_id=run_id,
            request_id=request_id,
            task=task,
            cancel_event=cancel_event,
            status='starting',
            execution_kind='agent_stream',
            concurrency_key=concurrency_key,
        )
        if task_id is None:
            return AgentStreamStartResult(
                started=False,
                session_id=session_id,
                request_id=request_id,
                error_message='该会话正在执行任务，请等待完成或停止当前任务',
            )

        context.metadata.update({
            'task_id': task_id,
            'session_id': session_id,
            'execution_kind': 'agent_stream',
            'request_id': request_id,
            '_execution': {
                'task_id': task_id,
                'session_id': session_id,
                'run_id': run_id,
                'execution_kind': 'agent_stream',
                'request_id': request_id,
            },
        })

        metrics_subscription_id = None
        sse_adapter = None
        subscription_ids: List[str] = []
        try:
            conversation_store.create_session(session_id=session_id, user_id=user_id)
            history_loader(context, session_id=session_id, limit=history_limit)

            metrics_collector = getattr(orchestrator, '_metrics_collector', None)
            if metrics_collector:
                metrics_subscription_id = metrics_collector.subscribe_to_events(event_bus)
                logger.info('✓ MetricsCollector 已订阅会话 %s 的事件总线', session_id)

            sse_adapter = SSEAdapter(
                event_bus=event_bus,
                session_id=session_id,
                buffer_size=100,
                heartbeat_interval=15.0,
            )

            # 创建持久化处理器并订阅事件
            persistence_handler = StreamPersistenceHandler(
                event_bus=event_bus,
                store=conversation_store,
                session_id=session_id,
                run_id=run_id,
                cancel_event=cancel_event,
                entry_agent_name=getattr(entry_agent, 'name', 'orchestrator_agent'),
            )
            subscriptions = persistence_handler.subscribe_all()
            final_answer_saved = persistence_handler.final_answer_saved
            message_id_for_run = persistence_handler.message_id_for_run

            user_msg = conversation_store.add_message(
                session_id=session_id,
                role='user',
                content=task,
                metadata={'agent': getattr(entry_agent, 'name', None)},
            )

            target = self._create_agent_task_target(
                task_id=task_id,
                event_bus=event_bus,
                final_answer_saved=final_answer_saved,
                entry_agent=entry_agent,
                registry=registry,
                run_id=run_id,
                session_id=session_id,
                store=conversation_store,
                task=task,
                context=context,
                user_message=user_msg,
            )

            sse_adapter.start()
            handle = self._execution_service.submit(
                ExecutionRequest(
                    execution_kind='agent_stream',
                    payload={'task': task, 'user_id': user_id},
                    session_id=session_id,
                    run_id=run_id,
                    request_id=request_id,
                    concurrency_key=concurrency_key,
                    task_id=task_id,
                ),
                target=target,
                cancel_event=cancel_event,
                event_bus=event_bus,
                metadata={'user_id': user_id, 'llm_override': llm_override},
                thread_name=f'agent-stream-{session_id[:8]}',
            )
            registry.mark_running(task_id, thread=handle.thread)

            subscription_ids = [
                subscriptions['run_steps'],
                subscriptions['persist_final_answer'],
                subscriptions['compression'],
                subscriptions['react_intermediate'],
                subscriptions['interrupt'],
            ]
            if metrics_subscription_id:
                subscription_ids.append(metrics_subscription_id)
            registry.set_task_persistent_subscriptions(task_id, subscription_ids, event_bus)

            return AgentStreamStartResult(
                started=True,
                session_id=session_id,
                run_id=run_id,
                task_id=task_id,
                request_id=request_id,
                sse_adapter=sse_adapter,
                handle=handle,
            )
        except Exception as error:
            logger.error('启动 Agent 流式执行失败 session=%s: %s', session_id, error, exc_info=True)
            registry.finish_task(task_id, status='failed')
            if sse_adapter is not None:
                try:
                    sse_adapter.stop()
                except Exception:
                    pass
            for subscription_id in subscription_ids:
                try:
                    event_bus.unsubscribe(subscription_id)
                except Exception:
                    pass
            if metrics_subscription_id and metrics_subscription_id not in subscription_ids:
                try:
                    event_bus.unsubscribe(metrics_subscription_id)
                except Exception:
                    pass
            return AgentStreamStartResult(
                started=False,
                session_id=session_id,
                run_id=run_id,
                task_id=task_id,
                request_id=request_id,
                error_message=str(error),
            )

    @staticmethod
    def _make_payload_safe(data: Any) -> Dict[str, Any]:
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

    @classmethod
    def _event_to_payload(cls, event) -> Dict[str, Any]:
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
            'data': cls._make_payload_safe(event.data),
            'requires_user_action': getattr(event, 'requires_user_action', False),
            'user_action_timeout': getattr(event, 'user_action_timeout', None),
        }
        apply_observability_fields(payload, event.data or {})
        if event.type in (EventType.CALL_AGENT_START, EventType.CALL_AGENT_END):
            called = (event.data or {}).get('agent_name')
            if called is not None:
                payload['agent_name'] = called
        return payload

    @staticmethod
    def _create_agent_task_target(
        *,
        task_id: str,
        event_bus,
        final_answer_saved,
        entry_agent,
        registry,
        run_id: str,
        session_id: str,
        store,
        task: str,
        context,
        user_message,
    ):
        def execute_agent_task(_execution_context):
            try:
                event_bus.publish(Event(
                    type=EventType.MESSAGE_SAVED,
                    data=attach_execution_metadata(
                        {'id': user_message['id'], 'seq': user_message.get('seq'), 'role': 'user'},
                        task_id=task_id,
                        session_id=session_id,
                        run_id=run_id,
                        execution_kind='agent_stream',
                        request_id=context.metadata.get('request_id'),
                    ),
                    session_id=session_id,
                    agent_name=getattr(entry_agent, 'name', None),
                ))
                logger.info('后台执行 Agent 任务: %s', task)
                response = entry_agent.execute(task, context)
                if response and getattr(response, 'content', None) and not final_answer_saved.is_set():
                    message = store.add_message(
                        session_id=session_id,
                        role='assistant',
                        content=response.content,
                        metadata={'agent': getattr(response, 'agent_name', None), 'run_id': run_id},
                    )
                    store.update_run_steps_message_id(session_id, run_id, message['id'])
                    final_answer_saved.set()
                logger.info('Agent 任务执行完成: %s', task)

                if response and getattr(response, 'error', None) == 'interrupted':
                    registry.finish_task(task_id, 'interrupted')
                    return ExecutionResult(
                        success=False,
                        status=ExecutionStatus.INTERRUPTED,
                        data=response,
                        error='interrupted',
                    )
                if isinstance(response, AgentResponse) and not response.success:
                    registry.finish_task(task_id, 'failed')
                    return ExecutionResult(
                        success=False,
                        status=ExecutionStatus.FAILED,
                        data=response,
                        error=response.error or '任务执行失败',
                    )

                registry.finish_task(task_id, 'completed')
                return response
            except Exception as error:
                logger.error('后台执行 Agent 失败: %s', error, exc_info=True)
                registry.finish_task(task_id, 'failed')
                publisher = EventPublisher(
                    agent_name='system',
                    session_id=session_id,
                    event_bus=event_bus,
                )
                publisher.agent_error(error=str(error), error_type='ExecutionError')
                raise
            finally:
                registry.cleanup_task_subscriptions(task_id)

        return execute_agent_task
