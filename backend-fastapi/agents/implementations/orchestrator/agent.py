# -*- coding: utf-8 -*-
"""Orchestrator Agent - 动态智能体编排器。"""

import logging
import time
from typing import Any, Dict, List, Optional

from agents.core import AgentContext, AgentResponse, BaseAgent
from tools.tool_registry import get_tool_registry

from .executor import AgentExecutor
from .prompting import (
    build_system_prompt,
    format_agent_result_summary,
    get_agent_display_name,
    get_available_agent_tools,
    replace_placeholders,
)
from .runtime import execute_orchestrator

logger = logging.getLogger(__name__)
_TOOL_REGISTRY = get_tool_registry()


class OrchestratorAgent(BaseAgent):
    """
    Orchestrator Agent - 动态智能体编排器

    核心特性：
    1. **Agent 作为工具**: 将其他 Agent 视为可调用的工具
    2. **ReAct 模式**: 使用推理-行动循环，动态决定调用哪个 Agent
    3. **XML 流式输出**: 实时展示思考和回答过程
    4. **完全可观察**: 每次 Agent 调用都有明确的输入输出
    """
    def __init__(
        self,
        orchestrator,
        model_adapter=None,
        agent_config=None,
        system_config=None,
        available_tools=None,
        available_skills=None
    ):
        """
        初始化 Orchestrator Agent

        Args:
            orchestrator: AgentOrchestrator 实例（用于访问其他 Agent）
            model_adapter: Model 适配器
            agent_config: 智能体配置
            system_config: 系统配置
            available_tools: 可直接调用的工具列表（来自 agent_configs.yaml 的 tools 配置）
            available_skills: 可用的 Skills 列表（来自 agent_configs.yaml 的 skills 配置）
        """
        super().__init__(
            name='orchestrator_agent',
            description='动态智能体编排器，将 Agent 当作工具使用',
            capabilities=[
                'dynamic_planning',
                'agent_coordination',
                'adaptive_execution'
            ],
            model_adapter=model_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.orchestrator = orchestrator
        self.agent_executor = AgentExecutor(orchestrator)
        from agents.context.budget import ORCHESTRATOR_CONTEXT_PROFILE_NAME
        self._setup_react_runtime(
            available_tools=available_tools,
            available_skills=available_skills,
            builtin_tool_getter=_TOOL_REGISTRY.get_builtin_tools_for_orchestrator,
            budget_profile_name=ORCHESTRATOR_CONTEXT_PROFILE_NAME,
            runtime_label="OrchestratorAgent",
        )

        # 注意：不在初始化时生成 Agent 工具列表
        # 因为此时其他 Agent 可能还未注册到 orchestrator
        # 延迟到 _get_available_agent_tools() 方法中动态获取

    def _get_agent_display_name(self, agent_name: str) -> str:
        return get_agent_display_name(self, agent_name)


    def _replace_placeholders(self, data: Any, agent_results: Dict[int, Dict[str, Any]]) -> Any:
        return replace_placeholders(self, data, agent_results)


    def _format_agent_result_summary(self, result: Dict[str, Any]) -> str:
        return format_agent_result_summary(self, result)


    def _get_available_agent_tools(self):
        return get_available_agent_tools(self)


    def _handle_user_input_request(
        self,
        arguments: dict,
        event_bus,
        session_id: str,
        tool_call_id: str,
        publisher=None,
        parent_call_id: str = None,
    ):
        return super()._handle_user_input_request(
            arguments=arguments,
            event_bus=event_bus,
            session_id=session_id,
            tool_call_id=tool_call_id,
            publisher=publisher,
            parent_call_id=parent_call_id,
            log_label="Orchestrator",
        )


    def _build_system_prompt(self) -> str:
        return build_system_prompt(self)


    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        return execute_orchestrator(self, task, context)

    def _get_runtime_log_label(self) -> str:
        return "Orchestrator"

    def _prepare_execution_state(
        self,
        task: str,
        context: AgentContext,
        start_time: float,
    ) -> Dict[str, Any]:
        event_bus = self._resolve_event_bus(context)

        import uuid
        orchestrator_call_id = f"call_{uuid.uuid4()}"
        run_id = context.metadata.get('run_id') or str(uuid.uuid4())
        parent_call_id = context.metadata.get('parent_call_id') if hasattr(context, 'metadata') else None

        self._ensure_publisher(
            context,
            event_bus=event_bus,
            call_id=orchestrator_call_id,
            parent_call_id=parent_call_id,
        )

        self._current_call_id = orchestrator_call_id
        self._parent_call_id = parent_call_id
        self._current_task_id = orchestrator_call_id

        self._publisher.run_start(run_id=run_id, metadata={"task": task})
        self._publisher.agent_call_start(
            call_id=orchestrator_call_id,
            agent_name=self.name,
            description=task,
        )
        agent_metadata = {
            "agent_name": self.name,
            "display_name": "Orchestrator Agent",
            "run_id": run_id,
            "call_id": orchestrator_call_id,
        }
        if self.max_rounds is not None:
            agent_metadata["max_rounds"] = self.max_rounds
        self._publisher.agent_start(task, metadata=agent_metadata)

        child_viz_count = [0]
        child_viz_sub_id = None
        if event_bus is not None:
            from agents.events.bus import EventType

            def _on_child_visualization(event):
                if event.agent_name != self.name:
                    child_viz_count[0] += 1

            child_viz_sub_id = event_bus.subscribe(
                event_types=[EventType.CHART_GENERATED, EventType.MAP_GENERATED],
                handler=_on_child_visualization,
                filter_func=lambda e: e.session_id == context.session_id,
            )

        return {
            'start_time': start_time,
            'event_bus': event_bus,
            'call_id': orchestrator_call_id,
            'parent_call_id': parent_call_id,
            'run_id': run_id,
            'current_session': [{"role": "user", "content": task}],
            'pending_visualizations': [],
            'visualization_counter': 0,
            'agent_calls_history': [],
            'global_agent_order': 0,
            'child_viz_count': child_viz_count,
            'child_viz_sub_id': child_viz_sub_id,
            'rounds': 0,
        }

    def _on_assistant_message(
        self,
        thought: str,
        actions: List[Dict[str, Any]],
        full_response: str,
        final_answer: str,
        rounds: int,
        state: Dict[str, Any],
    ) -> None:
        super()._on_assistant_message(
            thought=thought,
            actions=actions,
            full_response=full_response,
            final_answer=final_answer,
            rounds=rounds,
            state=state,
        )

    def _handle_actions(
        self,
        actions: List[Dict[str, Any]],
        context: AgentContext,
        state: Dict[str, Any],
        rounds: int,
        log_prefix: str,
    ) -> None:
        from .executor import parse_agent_invocation
        from .tool_router import route_user_input_request, route_agent_delegation, route_direct_tool

        event_bus = state.get('event_bus')
        observations = []
        agent_results = {}

        for idx, action in enumerate(actions, 1):
            self._check_interrupt(context)

            tool_name = action.get('tool')
            arguments = action.get('arguments', {})
            if not tool_name:
                continue

            original_arguments = arguments.copy()
            arguments = self._replace_placeholders(arguments, agent_results)
            if original_arguments != arguments:
                self.logger.info(f"{log_prefix} 占位符替换: {original_arguments} -> {arguments}")
            action = {**action, 'arguments': arguments}

            if tool_name == 'request_user_input':
                route_result = route_user_input_request(
                    agent=self,
                    action=action,
                    context=context,
                    event_bus=event_bus,
                    run_id=state['run_id'],
                    rounds=rounds,
                    idx=idx,
                    orchestrator_call_id=state['call_id'],
                )
                observations.append(route_result['observation'])
                agent_results[idx] = route_result['result']
                continue

            agent_name = parse_agent_invocation(tool_name)
            if agent_name:
                state['global_agent_order'] += 1
                route_result = route_agent_delegation(
                    agent=self,
                    action=action,
                    context=context,
                    event_bus=event_bus,
                    run_id=state['run_id'],
                    rounds=rounds,
                    idx=idx,
                    orchestrator_call_id=state['call_id'],
                    global_agent_order=state['global_agent_order'],
                    log_prefix=log_prefix,
                )
                state.setdefault('agent_calls_history', []).append(route_result['call_history'])
                agent_results[idx] = route_result['result']
                observations.append(route_result['observation'])
                continue

            route_result = route_direct_tool(
                agent=self,
                action=action,
                context=context,
                event_bus=event_bus,
                run_id=state['run_id'],
                rounds=rounds,
                idx=idx,
                orchestrator_call_id=state['call_id'],
                log_prefix=log_prefix,
            )

            agent_results[idx] = route_result['result']
            observations.append(route_result['observation'])
            viz_event = route_result.get('visualization_event')
            if viz_event:
                state['visualization_counter'] = state.get('visualization_counter', 0) + 1
                state.setdefault('pending_visualizations', []).append(viz_event)

        combined_observations = "\n\n".join(observations)
        state['current_session'].append({
            "role": "user",
            "content": combined_observations,
        })
        self._publisher.react_intermediate(
            role="user",
            content=state['current_session'][-1]["content"],
            round=rounds,
            msg_type="observation",
        )

    def _handle_no_action(
        self,
        llm_result: Any,
        context: AgentContext,
        state: Dict[str, Any],
        rounds: int,
        log_prefix: str,
    ) -> None:
        del llm_result, context
        self.logger.warning(f"{log_prefix} 既没有调用 Agent 也没有给出最终答案")
        state['current_session'].append({
            "role": "user",
            "content": "请直接输出 <answer> 或 <tools>。",
        })
        self._publisher.react_intermediate(
            role="user",
            content=state['current_session'][-1]["content"],
            round=rounds,
            msg_type="observation",
        )

    def _handle_llm_error(
        self,
        error_message: str,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        del context
        call_id = state.get('call_id')
        run_id = state.get('run_id')
        if self._publisher:
            self._publisher.agent_error(error=error_message, error_type="LLMError")
            if call_id:
                self._publisher.agent_call_end(
                    call_id=call_id,
                    agent_name=self.name,
                    result=error_message,
                    success=False,
                )
            self._publisher.agent_end(error_message, execution_time=time.time() - start_time)
            if run_id:
                self._publisher.run_end(
                    run_id=run_id,
                    status="error",
                    summary=error_message,
                )
        return AgentResponse(
            success=False,
            error=error_message,
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def _handle_final_answer(
        self,
        final_answer: str,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        del context
        total_viz = state.get('visualization_counter', 0) + state.get('child_viz_count', [0])[0]
        if total_viz > 0:
            from agents.utils.visualization_postprocess import ensure_chart_placeholders
            final_answer = ensure_chart_placeholders(final_answer, total_viz)

        call_id = state.get('call_id')
        run_id = state.get('run_id')
        if self._publisher:
            self._publisher.final_answer(final_answer)
            self._publish_deferred_visualizations(state.get('pending_visualizations'))
            if call_id:
                self._publisher.agent_call_end(
                    call_id=call_id,
                    agent_name=self.name,
                    result=final_answer,
                    success=True,
                )
            self._publisher.agent_end(final_answer, execution_time=time.time() - start_time)
            if run_id:
                self._publisher.run_end(
                    run_id=run_id,
                    status="success",
                    summary=f"任务完成，共 {state.get('rounds', 0)} 轮推理，{len(state.get('agent_calls_history', []))} 次Agent调用",
                )
        return AgentResponse(
            success=True,
            content=final_answer,
            agent_name=self.name,
            execution_time=time.time() - start_time,
            metadata={
                'rounds': state.get('rounds', 0),
                'agent_calls': len(state.get('agent_calls_history', [])),
            },
        )

    def _handle_max_rounds(
        self,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        del context
        self.logger.warning(f"{self._log_prefix(None, 'Orchestrator')} 达到最大轮数 {self.max_rounds}")
        final_content = "抱歉，经过多轮分析后仍无法给出完整答案。建议重新描述问题或提供更多信息。"
        call_id = state.get('call_id')
        run_id = state.get('run_id')
        if self._publisher:
            self._publisher.final_answer(final_content)
            if call_id:
                self._publisher.agent_call_end(
                    call_id=call_id,
                    agent_name=self.name,
                    result=final_content,
                    success=False,
                )
            self._publisher.agent_end(final_content, execution_time=time.time() - start_time)
            if run_id:
                self._publisher.run_end(
                    run_id=run_id,
                    status="max_rounds",
                    summary=f"达到最大轮数 {self.max_rounds}",
                )
            self._publisher.session_end(summary=f"达到最大轮数 {self.max_rounds}")
        return AgentResponse(
            success=True,
            content=final_content,
            agent_name=self.name,
            execution_time=time.time() - start_time,
            metadata={
                'rounds': state.get('rounds', 0),
                'max_rounds_reached': True,
                'agent_calls': len(state.get('agent_calls_history', [])),
            },
        )

    def _handle_interrupted(
        self,
        error,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        del context
        self.logger.info(f"任务被用户中断: {error}")
        call_id = state.get('call_id')
        run_id = state.get('run_id')
        if self._publisher:
            if call_id:
                self._publisher.agent_call_end(
                    call_id=call_id,
                    agent_name=self.name,
                    result="[已停止生成]",
                    success=False,
                )
            self._publisher.agent_error(error=str(error), error_type="InterruptedError")
            if run_id:
                self._publisher.run_end(
                    run_id=run_id,
                    status="interrupted",
                    summary="用户中断执行",
                )
        return AgentResponse(
            success=False,
            content="[已停止生成]",
            error="interrupted",
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def _handle_execution_error(
        self,
        error: Exception,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        del context
        self.logger.error(f"执行任务失败: {error}", exc_info=True)
        call_id = state.get('call_id')
        run_id = state.get('run_id')
        if self._publisher:
            if call_id:
                self._publisher.agent_call_end(
                    call_id=call_id,
                    agent_name=self.name,
                    result=str(error),
                    success=False,
                )
            self._publisher.agent_error(error=str(error), error_type="ExecutionError")
            if run_id:
                self._publisher.run_end(
                    run_id=run_id,
                    status="error",
                    summary=f"执行失败: {error}",
                )
        return AgentResponse(
            success=False,
            error=str(error),
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def _cleanup_execution(
        self,
        context: AgentContext,
        state: Dict[str, Any],
    ) -> None:
        del context
        event_bus = state.get('event_bus')
        sub_id = state.get('child_viz_sub_id')
        if event_bus is not None and sub_id is not None:
            try:
                event_bus.unsubscribe(sub_id)
            except Exception:
                pass


    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        return True
