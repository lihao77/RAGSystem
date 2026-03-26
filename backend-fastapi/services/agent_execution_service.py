# -*- coding: utf-8 -*-
"""Unified agent execution service."""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from typing import Optional, Literal

from agents.core.models import AgentResponse
from runtime.dependencies import get_runtime_dependency
from tools.runtime.response_builder import error_result, success_result
from tools.contracts.result_models import ToolExecutionResult


@dataclass(slots=True)
class AgentExecutionHandle:
    agent: object
    context: object
    run_id: str
    thread_key: str
    child_agent_id: Optional[str]
    created_run: bool


@dataclass(slots=True)
class AgentInvocationResult:
    response: AgentResponse
    run_id: str
    thread_key: str
    child_agent_id: Optional[str]
    context: object


class AgentExecutionService:
    """统一的 agent 执行入口，供 API 与 call_agent 复用。"""

    def __init__(self, runtime_service=None):
        if runtime_service is None:
            from services.agent_api_runtime_service import get_agent_api_runtime_service
            runtime_service = get_agent_api_runtime_service()
        self._runtime = runtime_service

    @staticmethod
    def _normalize_thread_key(thread_key: Optional[str]) -> str:
        return (thread_key or '').strip() or 'root'

    @classmethod
    def _resolve_child_thread_key(cls, child_agent_id: Optional[str], thread_key: Optional[str]) -> str:
        if child_agent_id:
            return f"child:{child_agent_id}"
        return cls._normalize_thread_key(thread_key)

    @staticmethod
    def _resolve_conversation_scope(mode: Literal['root', 'child']) -> str:
        return 'child' if mode == 'child' else 'root'

    @classmethod
    def _resolve_thread_key_for_mode(
        cls,
        mode: Literal['root', 'child'],
        *,
        thread_key: Optional[str],
        child_agent_id: Optional[str],
    ) -> str:
        if mode == 'child':
            return cls._resolve_child_thread_key(child_agent_id, thread_key)
        return 'root'

    @staticmethod
    def _merge_task(task: str, context_hint: Optional[str]) -> str:
        if context_hint:
            return f"{task}\n\n【上下文提示】{context_hint}"
        return task

    @staticmethod
    def _response_to_tool_result(
        agent_name: str,
        response: AgentResponse,
        *,
        run_id: str,
        thread_key: str,
        child_agent_id: Optional[str],
    ) -> ToolExecutionResult:
        if not response.success:
            return error_result(
                response.error or f"Agent '{agent_name}' 执行失败",
                tool_name=agent_name,
                metadata={
                    'agent_name': agent_name,
                    'run_id': run_id,
                    'thread_key': thread_key,
                    'child_agent_id': child_agent_id,
                },
            )

        output_type = 'json' if isinstance(response.content, (dict, list)) else 'text'
        metadata = {
            **(response.metadata or {}),
            'agent_name': agent_name,
            'run_id': run_id,
            'thread_key': thread_key,
            'child_agent_id': child_agent_id,
            'execution_time': response.execution_time,
            'tool_calls': len(response.tool_calls) if response.tool_calls else 0,
        }
        summary = response.content if isinstance(response.content, str) and len(response.content) <= 200 else ''
        if not summary:
            summary = response.error or 'Agent 执行完成'
        result = success_result(
            content=response.content,
            summary=summary,
            answer=response.content if isinstance(response.content, str) else None,
            output_type=output_type,
            metadata=metadata,
            tool_name=agent_name,
        )
        if getattr(response, 'artifacts', None):
            result.artifacts = list(response.artifacts)
        return result

    def prepare_execution(
        self,
        *,
        mode: Literal['root', 'child'] = 'root',
        agent_name: str,
        session_id: str,
        user_id: Optional[str] = None,
        llm_override: Optional[dict] = None,
        request_id: Optional[str] = None,
        run_id: Optional[str] = None,
        parent_run_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        call_id: Optional[str] = None,
        event_bus=None,
        cancel_event=None,
        thread_key: Optional[str] = None,
        child_agent_id: Optional[str] = None,
        history_limit: int = 200,
        entrypoint: str = 'execute',
        task_summary: str = '',
        source: str = 'api',
    ) -> AgentExecutionHandle:
        store = self._runtime.get_conversation_store()
        resolved_child_agent_id = child_agent_id if mode == 'child' else None
        if resolved_child_agent_id:
            child_agent = store.get_child_agent(session_id=session_id, child_agent_id=resolved_child_agent_id)
            if child_agent is None:
                raise LookupError(f"子 Agent '{resolved_child_agent_id}' 不存在")
            if child_agent.get('status') != 'active':
                raise LookupError(f"子 Agent '{resolved_child_agent_id}' 当前不可用")
            if child_agent.get('agent_name') != agent_name:
                raise LookupError(f"子 Agent '{resolved_child_agent_id}' 与目标 Agent '{agent_name}' 不匹配")
            resolved_thread_key = child_agent.get('thread_key') or self._resolve_thread_key_for_mode(
                mode,
                thread_key=None,
                child_agent_id=resolved_child_agent_id,
            )
        else:
            resolved_thread_key = self._resolve_thread_key_for_mode(
                mode,
                thread_key=thread_key,
                child_agent_id=None,
            )
        resolved_run_id = run_id or str(uuid.uuid4())
        created_run = run_id is None
        conversation_scope = self._resolve_conversation_scope(mode)

        orchestrator = self._runtime.create_execution_orchestrator(session_id=session_id)
        target_agent = getattr(orchestrator, 'agents', {}).get(agent_name)
        if target_agent is None:
            raise LookupError(f"目标 Agent '{agent_name}' 未成功加载")

        context = self._runtime.build_context(
            session_id=session_id,
            user_id=user_id,
            limit=history_limit,
            run_id=resolved_run_id,
            request_id=request_id,
            llm_override=llm_override,
            thread_key=resolved_thread_key,
            parent_run_id=parent_run_id,
            parent_call_id=parent_call_id,
            call_id=call_id,
        )
        context.metadata['agent_name'] = agent_name
        context.metadata['execution_source'] = source
        context.metadata['execution_mode'] = mode
        context.metadata['thread_key'] = resolved_thread_key
        context.metadata['conversation_scope'] = conversation_scope
        if resolved_child_agent_id:
            context.metadata['child_agent_id'] = resolved_child_agent_id
        if event_bus is not None:
            context.metadata['event_bus'] = event_bus
        if cancel_event is not None:
            context.metadata['cancel_event'] = cancel_event
        elif 'cancel_event' not in context.metadata:
            context.metadata['cancel_event'] = threading.Event()

        if created_run:
            store.create_run(
                run_id=resolved_run_id,
                session_id=session_id,
                entrypoint=entrypoint,
                status='running',
                task_summary=task_summary,
                user_id=user_id,
                agent_name=agent_name,
                thread_key=resolved_thread_key,
                parent_run_id=parent_run_id,
                parent_call_id=parent_call_id,
                child_agent_id=resolved_child_agent_id,
            )
            if resolved_child_agent_id:
                store.update_child_agent_last_run(
                    session_id=session_id,
                    child_agent_id=resolved_child_agent_id,
                    last_run_id=resolved_run_id,
                )

        return AgentExecutionHandle(
            agent=target_agent,
            context=context,
            run_id=resolved_run_id,
            thread_key=resolved_thread_key,
            child_agent_id=resolved_child_agent_id,
            created_run=created_run,
        )

    def invoke_agent(
        self,
        *,
        mode: Literal['root', 'child'] = 'root',
        agent_name: str,
        task: str,
        session_id: str,
        user_id: Optional[str] = None,
        context_hint: Optional[str] = None,
        llm_override: Optional[dict] = None,
        request_id: Optional[str] = None,
        run_id: Optional[str] = None,
        parent_run_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        call_id: Optional[str] = None,
        event_bus=None,
        cancel_event=None,
        thread_key: Optional[str] = None,
        child_agent_id: Optional[str] = None,
        history_limit: int = 200,
        entrypoint: str = 'execute',
        source: str = 'api',
        persist_user_message: bool = False,
        persist_final_answer: bool = False,
        visible_to_user: Optional[bool] = None,
        prepared_handle: Optional[AgentExecutionHandle] = None,
    ) -> AgentInvocationResult:
        store = self._runtime.get_conversation_store()
        effective_visible = visible_to_user if visible_to_user is not None else (mode == 'root')
        effective_thread_key = self._resolve_thread_key_for_mode(
            mode,
            thread_key=thread_key,
            child_agent_id=child_agent_id,
        )
        effective_scope = self._resolve_conversation_scope(mode)
        if persist_user_message:
            store.add_message(
                session_id=session_id,
                role='user',
                content=task,
                metadata={
                    'agent': agent_name,
                    'thread_key': effective_thread_key,
                    'conversation_scope': effective_scope,
                    'visible_to_user': effective_visible,
                    'child_agent_id': child_agent_id,
                },
                thread_key=effective_thread_key,
                child_agent_id=child_agent_id,
            )

        handle = prepared_handle or self.prepare_execution(
            mode=mode,
            agent_name=agent_name,
            session_id=session_id,
            user_id=user_id,
            llm_override=llm_override,
            request_id=request_id,
            run_id=run_id,
            parent_run_id=parent_run_id,
            parent_call_id=parent_call_id,
            call_id=call_id,
            event_bus=event_bus,
            cancel_event=cancel_event,
            thread_key=thread_key,
            child_agent_id=child_agent_id,
            history_limit=history_limit,
            entrypoint=entrypoint,
            task_summary=task[:200],
            source=source,
        )
        effective_thread_key = handle.thread_key
        effective_scope = getattr(handle.context, 'metadata', {}).get('conversation_scope', effective_scope)
        effective_child_agent_id = handle.child_agent_id
        merged_task = self._merge_task(task, context_hint)
        response = handle.agent.execute(merged_task, handle.context)
        if persist_final_answer and response.success and response.content:
            message = store.add_message(
                session_id=session_id,
                role='assistant',
                content=response.content if isinstance(response.content, str) else str(response.content),
                metadata={
                    'agent': response.agent_name,
                    'run_id': handle.run_id,
                    'thread_key': handle.thread_key,
                    'conversation_scope': effective_scope,
                    'visible_to_user': effective_visible,
                    'child_agent_id': effective_child_agent_id,
                },
                thread_key=handle.thread_key,
                child_agent_id=effective_child_agent_id,
            )
            store.update_run_steps_message_id(session_id, handle.run_id, message['id'])
        return AgentInvocationResult(
            response=response,
            run_id=handle.run_id,
            thread_key=handle.thread_key,
            child_agent_id=effective_child_agent_id,
            context=handle.context,
        )

    def execute_agent_call(
        self,
        *,
        agent_name: str,
        task: str,
        session_id: str,
        user_id: Optional[str] = None,
        context_hint: Optional[str] = None,
        llm_override: Optional[dict] = None,
        request_id: Optional[str] = None,
        run_id: Optional[str] = None,
        parent_run_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        call_id: Optional[str] = None,
        event_bus=None,
        cancel_event=None,
        thread_key: Optional[str] = None,
        child_agent_id: Optional[str] = None,
        history_limit: int = 200,
        entrypoint: str = 'execute',
        source: str = 'api',
    ) -> ToolExecutionResult:
        try:
            invocation = self.invoke_agent(
                mode='child' if child_agent_id else 'root',
                agent_name=agent_name,
                task=task,
                session_id=session_id,
                user_id=user_id,
                context_hint=context_hint,
                llm_override=llm_override,
                request_id=request_id,
                run_id=run_id,
                parent_run_id=parent_run_id,
                parent_call_id=parent_call_id,
                call_id=call_id,
                event_bus=event_bus,
                cancel_event=cancel_event,
                thread_key=thread_key,
                child_agent_id=child_agent_id,
                history_limit=history_limit,
                entrypoint=entrypoint,
                source=source,
                persist_user_message=bool(child_agent_id),
                persist_final_answer=bool(child_agent_id),
                visible_to_user=False if child_agent_id else None,
            )
        except Exception as error:
            return error_result(str(error), tool_name=agent_name)

        return self._response_to_tool_result(
            agent_name,
            invocation.response,
            run_id=invocation.run_id,
            thread_key=invocation.thread_key,
            child_agent_id=invocation.child_agent_id,
        )


def get_agent_execution_service() -> AgentExecutionService:
    return get_runtime_dependency(container_getter='get_agent_execution_service')
