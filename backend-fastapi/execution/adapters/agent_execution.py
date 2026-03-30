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
from execution.step_projector import StepProjector
from services.execution_service import ExecutionService, get_execution_service
from services.agent_execution_service import AgentExecutionService, get_agent_execution_service

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

    def __init__(
        self,
        execution_service: Optional[ExecutionService] = None,
        agent_execution_service: Optional[AgentExecutionService] = None,
    ):
        self._execution_service = execution_service or get_execution_service()
        self._agent_execution_service = agent_execution_service or get_agent_execution_service()

    def start_stream_execution(
        self,
        *,
        task: str,
        session_id: str,
        user_id: Optional[str],
        llm_override: Optional[Dict[str, Optional[str]]],
        llm_tier: Optional[str],
        request_id: Optional[str],
        conversation_store,
        orchestrator,
        history_loader: Callable[[AgentContext, str, int], None],
        history_limit: int = 200,
        current_attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> AgentStreamStartResult:
        del history_loader
        registry = self._execution_service.get_task_registry()
        session_manager = self._execution_service.get_session_manager()

        cancel_event = threading.Event()

        entry_agent = orchestrator.resolve_default_entry_agent() if hasattr(orchestrator, 'resolve_default_entry_agent') else None
        if not entry_agent:
            return AgentStreamStartResult(
                started=False,
                session_id=session_id,
                request_id=request_id,
                error_message='默认入口智能体未找到，请确认已正确加载',
            )

        run_id = str(uuid.uuid4())
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

        event_bus = session_manager.get_or_create(run_id, session_id=session_id)

        metrics_subscription_id = None
        sse_adapter = None
        step_projector_subscription_id = None
        subscription_ids: List[str] = []
        try:
            session = conversation_store.get_session(session_id)
            if not session:
                conversation_store.create_session(session_id=session_id, user_id=user_id)

            execution_handle = self._agent_execution_service.prepare_execution(
                agent_name=getattr(entry_agent, 'name', None) or 'orchestrator_agent',
                session_id=session_id,
                user_id=user_id,
                llm_override=llm_override,
                llm_tier=llm_tier,
                request_id=request_id,
                run_id=run_id,
                parent_run_id=None,
                parent_call_id=None,
                event_bus=event_bus,
                cancel_event=cancel_event,
                thread_key='root',
                history_limit=history_limit,
                entrypoint='agent_stream',
                task_summary=task[:200],
                source='api',
            )
            context = execution_handle.context
            context.metadata['current_user_input'] = task
            if current_attachments:
                context.metadata['current_attachments'] = list(current_attachments)
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

            metrics_collector = getattr(orchestrator, '_metrics_collector', None)
            if metrics_collector:
                metrics_subscription_id = metrics_collector.subscribe_to_events(event_bus)
                logger.info('✓ MetricsCollector 已订阅 run=%s session=%s 的事件总线', run_id, session_id)

            step_projector = StepProjector(event_bus=event_bus, session_id=session_id)
            step_projector_subscription_id = step_projector.subscribe()

            sse_adapter = SSEAdapter(
                event_bus=event_bus,
                session_id=session_id,
                buffer_size=100,
                heartbeat_interval=15.0,
            )

            persistence_handler = StreamPersistenceHandler(
                event_bus=event_bus,
                store=conversation_store,
                session_id=session_id,
                run_id=run_id,
                cancel_event=cancel_event,
                entry_agent_name=getattr(entry_agent, 'name', 'orchestrator_agent'),
                thread_key=execution_handle.thread_key,
                conversation_scope=context.metadata.get('conversation_scope', 'root'),
                visible_to_user=True,
                child_agent_id=execution_handle.child_agent_id,
            )
            subscriptions = persistence_handler.subscribe_all()
            final_answer_saved = persistence_handler.final_answer_saved

            user_msg = self._agent_execution_service.persist_user_message(
                session_id=session_id,
                task=task,
                agent_name=getattr(entry_agent, 'name', None),
                mode='child' if execution_handle.child_agent_id else 'root',
                run_id=run_id,
                thread_key=execution_handle.thread_key,
                child_agent_id=execution_handle.child_agent_id,
                visible_to_user=True,
                attachments=current_attachments,
            )

            target = self._create_agent_task_target(
                task_id=task_id,
                event_bus=event_bus,
                final_answer_saved=final_answer_saved,
                agent_execution_service=self._agent_execution_service,
                execution_handle=execution_handle,
                registry=registry,
                run_id=run_id,
                session_id=session_id,
                store=conversation_store,
                task=task,
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
                metadata={'user_id': user_id, 'llm_override': llm_override, 'llm_tier': llm_tier},
                thread_name=f'agent-stream-{session_id[:8]}',
            )
            registry.mark_running(task_id, thread=handle.thread)

            subscription_ids = [
                step_projector_subscription_id,
                subscriptions['run_steps'],
                subscriptions['final_answer'],
                subscriptions['entry_call_id'],
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
            if step_projector_subscription_id and step_projector_subscription_id not in subscription_ids:
                try:
                    event_bus.unsubscribe(step_projector_subscription_id)
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
        agent_execution_service: AgentExecutionService,
        execution_handle,
        registry,
        run_id: str,
        session_id: str,
        store,
        task: str,
        user_message,
    ):
        def execute_agent_task(_execution_context):
            context = execution_handle.context
            entry_agent = execution_handle.agent
            thread_key = context.metadata.get('thread_key', execution_handle.thread_key)
            child_agent_id = context.metadata.get('child_agent_id', execution_handle.child_agent_id)
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
                invocation = agent_execution_service.invoke_agent(
                    mode='child' if child_agent_id else 'root',
                    agent_name=getattr(entry_agent, 'name', None),
                    task=task,
                    session_id=session_id,
                    user_id=context.user_id,
                    llm_override=context.llm_override,
                    request_id=context.metadata.get('request_id'),
                    run_id=run_id,
                    parent_run_id=context.metadata.get('parent_run_id'),
                    parent_call_id=context.metadata.get('parent_call_id'),
                    call_id=context.metadata.get('call_id'),
                    event_bus=event_bus,
                    cancel_event=context.metadata.get('cancel_event'),
                    thread_key=thread_key,
                    child_agent_id=child_agent_id,
                    history_limit=0,
                    entrypoint='agent_stream',
                    source='api',
                    persist_user_message=False,
                    persist_final_answer=False,
                    prepared_handle=execution_handle,
                )
                response = invocation.response
                if response and getattr(response, 'content', None) and not final_answer_saved.is_set():
                    event_bus.publish(Event(
                        type=EventType.FINAL_ANSWER,
                        data=attach_execution_metadata(
                            {
                                'content': response.content,
                                'task_id': task_id,
                                'request_id': context.metadata.get('request_id'),
                            },
                            task_id=task_id,
                            session_id=session_id,
                            run_id=run_id,
                            execution_kind='agent_stream',
                            request_id=context.metadata.get('request_id'),
                        ),
                        session_id=session_id,
                        agent_name=getattr(response, 'agent_name', None),
                        call_id=context.metadata.get('call_id'),
                        parent_call_id=context.metadata.get('parent_call_id'),
                    ))
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
                if run_id:
                    publisher.run_end(
                        run_id=run_id,
                        status='error',
                        summary=f'后台执行失败: {error}',
                    )
                raise
            finally:
                registry.cleanup_task_subscriptions(task_id)

        return execute_agent_task
