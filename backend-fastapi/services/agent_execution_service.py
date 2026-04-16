# -*- coding: utf-8 -*-
"""Unified agent execution service."""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from typing import Optional, Literal, Tuple, Dict, Any

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
        llm_tier: Optional[str] = None,
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
        child_workspace_root = None
        child_original_workspace_root = None
        child_uses_worktree = None
        if resolved_child_agent_id:
            child_agent = store.get_child_agent(session_id=session_id, child_agent_id=resolved_child_agent_id)
            if child_agent is None:
                raise LookupError(f"子 Agent '{resolved_child_agent_id}' 不存在")
            if child_agent.get('status') != 'active':
                raise LookupError(f"子 Agent '{resolved_child_agent_id}' 当前不可用")
            if child_agent.get('agent_name') != agent_name:
                raise LookupError(f"子 Agent '{resolved_child_agent_id}' 与目标 Agent '{agent_name}' 不匹配")
            child_metadata = child_agent.get('metadata') or {}
            child_workspace_root = child_metadata.get('workspace_root')
            child_original_workspace_root = child_metadata.get('original_workspace_root')
            child_uses_worktree = child_metadata.get('uses_worktree')
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
            llm_tier=llm_tier,
            thread_key=resolved_thread_key,
            parent_run_id=parent_run_id,
            parent_call_id=parent_call_id,
            call_id=call_id,
            agent_name=agent_name,
        )
        context.metadata['agent_name'] = agent_name
        context.metadata['execution_source'] = source
        context.metadata['execution_mode'] = mode
        context.metadata['thread_key'] = resolved_thread_key
        context.metadata['conversation_scope'] = conversation_scope
        if child_workspace_root:
            context.metadata['workspace_root'] = child_workspace_root
        if child_original_workspace_root:
            context.metadata['original_workspace_root'] = child_original_workspace_root
        if child_uses_worktree is not None:
            context.metadata['uses_worktree'] = child_uses_worktree
        if resolved_child_agent_id:
            context.metadata['child_agent_id'] = resolved_child_agent_id
            # NOTE: target_agent 由 create_execution_orchestrator 每次新建，
            # 此处 mutate custom_params 不会影响其他 execution 实例。
            agent_config = getattr(target_agent, 'agent_config', None)
            if agent_config is not None:
                custom_params = getattr(agent_config, 'custom_params', None)
                copied_params = dict(custom_params) if isinstance(custom_params, dict) else {}
                copied_params['workspace_root'] = child_workspace_root or copied_params.get('workspace_root')
                target_agent.agent_config.custom_params = copied_params
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

    def _route_root_agent(
        self,
        *,
        task: str,
        session_id: str,
        preferred_agent: Optional[str] = None,
        user_id: Optional[str] = None,
        llm_override: Optional[dict] = None,
        llm_tier: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> Tuple[str, object]:
        orchestrator = self._runtime.create_execution_orchestrator(session_id=session_id)
        context = self._runtime.build_context(
            session_id=session_id,
            user_id=user_id,
            limit=0,
            run_id=None,
            request_id=request_id,
            llm_override=llm_override,
            llm_tier=llm_tier,
            thread_key='root',
            parent_run_id=None,
            parent_call_id=None,
            call_id=None,
            agent_name=preferred_agent,
        )
        routed_agent = orchestrator.route_task(task, context, preferred_agent=preferred_agent)
        if routed_agent is None:
            raise LookupError('未找到合适的智能体来处理此任务')
        return routed_agent.name, routed_agent

    def resolve_routed_root_agent(
        self,
        *,
        task: str,
        session_id: str,
        preferred_agent: Optional[str] = None,
        user_id: Optional[str] = None,
        llm_override: Optional[dict] = None,
        llm_tier: Optional[str] = None,
        request_id: Optional[str] = None,
    ):
        _, routed_agent = self._route_root_agent(
            task=task,
            session_id=session_id,
            preferred_agent=preferred_agent,
            user_id=user_id,
            llm_override=llm_override,
            llm_tier=llm_tier,
            request_id=request_id,
        )
        return routed_agent

    def invoke_routed_agent(
        self,
        *,
        task: str,
        session_id: str,
        preferred_agent: Optional[str] = None,
        user_id: Optional[str] = None,
        context_hint: Optional[str] = None,
        llm_override: Optional[dict] = None,
        llm_tier: Optional[str] = None,
        request_id: Optional[str] = None,
        run_id: Optional[str] = None,
        parent_run_id: Optional[str] = None,
        parent_call_id: Optional[str] = None,
        call_id: Optional[str] = None,
        event_bus=None,
        cancel_event=None,
        history_limit: int = 200,
        entrypoint: str = 'execute',
        source: str = 'api',
        persist_user_message: bool = False,
        persist_final_answer: bool = False,
        visible_to_user: Optional[bool] = None,
    ) -> AgentInvocationResult:
        agent_name, _ = self._route_root_agent(
            task=task,
            session_id=session_id,
            preferred_agent=preferred_agent,
            user_id=user_id,
            llm_override=llm_override,
            llm_tier=llm_tier,
            request_id=request_id,
        )
        return self.invoke_agent(
            mode='root',
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
            thread_key='root',
            child_agent_id=None,
            history_limit=history_limit,
            entrypoint=entrypoint,
            source=source,
            persist_user_message=persist_user_message,
            persist_final_answer=persist_final_answer,
            visible_to_user=visible_to_user,
        )

    def persist_user_message(
        self,
        *,
        session_id: str,
        task: str,
        agent_name: Optional[str],
        mode: Literal['root', 'child'] = 'root',
        run_id: Optional[str] = None,
        thread_key: Optional[str] = None,
        child_agent_id: Optional[str] = None,
        visible_to_user: Optional[bool] = None,
        attachments: Optional[list] = None,
        extra_metadata: Optional[Dict[str, Any]] = None,
    ):
        store = self._runtime.get_conversation_store()
        effective_visible = visible_to_user if visible_to_user is not None else (mode == 'root')
        effective_thread_key = self._resolve_thread_key_for_mode(
            mode,
            thread_key=thread_key,
            child_agent_id=child_agent_id,
        )
        effective_scope = self._resolve_conversation_scope(mode)
        metadata = {
            'agent': agent_name,
            'run_id': run_id,
            'thread_key': effective_thread_key,
            'conversation_scope': effective_scope,
            'visible_to_user': effective_visible,
            'child_agent_id': child_agent_id,
            'attachments': list(attachments or []),
        }
        if extra_metadata:
            metadata.update(extra_metadata)

        # ── 用户消息提交时创建 file history snapshot ──
        result = store.add_message(
            session_id=session_id,
            role='user',
            content=task,
            metadata=metadata,
            thread_key=effective_thread_key,
            child_agent_id=child_agent_id,
        )
        if mode == 'root' and session_id:
            try:
                from services.file_history import get_file_history
                seq = result.get('seq')
                if seq is not None:
                    snapshot_id = get_file_history(session_id).make_snapshot(seq)
                    if snapshot_id:
                        result['metadata']['snapshot_id'] = snapshot_id
            except Exception:
                pass
        return result

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
        llm_tier: Optional[str] = None,
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
        can_persist_messages = hasattr(store, 'add_message') and hasattr(store, 'update_run_steps_message_id')
        if persist_user_message and can_persist_messages:
            self.persist_user_message(
                session_id=session_id,
                task=task,
                agent_name=agent_name,
                mode=mode,
                run_id=run_id,
                thread_key=effective_thread_key,
                child_agent_id=child_agent_id,
                visible_to_user=effective_visible,
            )

        handle = prepared_handle or self.prepare_execution(
            mode=mode,
            agent_name=agent_name,
            session_id=session_id,
            user_id=user_id,
            llm_override=llm_override,
            llm_tier=llm_tier,
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
        # flush pipeline 缓存到 DB（per-run 持久化）
        try:
            from agents.context.session_cache import flush_session
            flush_session(session_id)
        except Exception:
            pass
        if persist_final_answer and can_persist_messages and response.success and response.content:
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
        llm_tier: Optional[str] = None,
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
                llm_tier=llm_tier,
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
