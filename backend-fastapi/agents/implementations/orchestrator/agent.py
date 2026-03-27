# -*- coding: utf-8 -*-
"""Orchestrator Agent - 动态智能体编排器。"""

import logging
import time
from typing import Any, Dict, List, Optional

from agents.core import AgentContext, AgentResponse, BaseAgent
from tools.tool_registry import get_tool_registry

from .prompting import (
    build_orchestrator_specific_sections,
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
    通用 ReAct 智能体。

    既可作为主编排器（持有 orchestrator 引用，调度其他 Agent），
    也可作为独立 Worker（orchestrator=None，专注工具调用）。
    所有智能体统一使用此类，通过配置区分行为。
    """
    def __init__(
        self,
        orchestrator=None,
        model_adapter=None,
        agent_config=None,
        system_config=None,
        available_tools=None,
        available_skills=None,
        agent_name: Optional[str] = None,
        display_name: Optional[str] = None,
        description: Optional[str] = None,
    ):
        _name = agent_name or (agent_config.agent_name if agent_config else None) or 'orchestrator_agent'
        _desc = description or (agent_config.description if agent_config else None) or '动态智能体编排器'
        super().__init__(
            name=_name,
            description=_desc,
            capabilities=['dynamic_planning', 'agent_coordination', 'adaptive_execution'],
            model_adapter=model_adapter,
            agent_config=agent_config,
            system_config=system_config
        )

        self.display_name = display_name or (agent_config.display_name if agent_config else None) or _name
        self.orchestrator = orchestrator
        from agents.context.budget import ORCHESTRATOR_CONTEXT_PROFILE_NAME, WORKER_CONTEXT_PROFILE_NAME
        budget_profile_name = WORKER_CONTEXT_PROFILE_NAME if orchestrator is None else ORCHESTRATOR_CONTEXT_PROFILE_NAME
        self._setup_react_runtime(
            available_tools=available_tools,
            available_skills=available_skills,
            budget_profile_name=budget_profile_name,
            runtime_label=self.display_name,
        )

    def _get_agent_display_name(self, agent_name: str) -> str:
        return get_agent_display_name(self, agent_name)

    def _replace_placeholders(self, data: Any, agent_results: Dict[int, Dict[str, Any]]) -> Any:
        return replace_placeholders(self, data, agent_results)

    def _format_agent_result_summary(self, result: Dict[str, Any]) -> str:
        return format_agent_result_summary(self, result)

    def _get_available_agent_tools(self):
        return get_available_agent_tools(self)

    def _build_agent_roster_for_prompt(self):
        from .prompting import _build_agent_roster
        return _build_agent_roster(self)

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

    def _build_prompt_goal_section(self) -> str:
        return """## 工作目标

你是主编排器。你的职责不是展示思考，而是把任务可靠地完成。优先级如下：
1. 准确理解用户需求
2. 选择成本最低且成功率最高的执行路径
3. 只有在必要时才委派子 Agent 或调用直接工具
4. 信息足够时直接输出 `<final_answer>`
5. 信息不足且无法通过现有工具补齐时，调用 `request_user_input`"""

    def _build_prompt_principles_section(self) -> str:
        return """## 编排原则

- 先判断能否直接回答，或由一个直接工具完成；不要机械委派
- 需要专业能力时，优先委派一个最匹配的子 Agent；只有确实存在依赖关系时才做多 Agent 链式调用
- 子 Agent 返回数据文件时只返回文件路径（格式 `[data:路径]`），不返回文件内容；收到路径后直接传给下游 Agent 或工具
- 委派子 Agent 时，task 中明确要求"返回数据文件路径，不要返回文件内容"
- 多个相互独立的任务可放在同一 `<tools>` 中并行
- 如果上一轮结果已经足够，不要重复调用相同 Agent 或工具
- 工具或 Agent 报错后，下一轮应换策略、补参数或缩小任务，不要机械重试
- 最终答案使用用户语言，先给结论，再给必要细节；不确定处要明确说明边界"""

    def _build_agent_specific_prompt_sections(self):
        return build_orchestrator_specific_sections(self)

    def _build_system_prompt(self) -> str:
        return BaseAgent._build_shared_system_prompt(self)

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
        """Orchestrator 在基础状态上额外追踪 agent_calls_history 和调用树事件。"""
        import uuid
        state = super()._prepare_execution_state(task, context, start_time)

        # 补充 orchestrator 特有状态
        state['agent_calls_history'] = []
        state['global_agent_order'] = 0

        # 发布 agent_call_start 供前端构建调用树
        publisher = state.get('publisher')
        if publisher:
            publisher.agent_call_start(
                call_id=state['call_id'],
                agent_name=self.name,
                description=task,
            )

        return state

    def _handle_actions(
        self,
        actions: List[Dict[str, Any]],
        context: AgentContext,
        state: Dict[str, Any],
        rounds: int,
        log_prefix: str,
    ) -> None:
        from .tool_router import route_direct_tool

        event_bus = state.get('event_bus')
        publisher = state.get('publisher')
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

            route_result = route_direct_tool(
                agent=self,
                action=action,
                context=context,
                event_bus=event_bus,
                publisher=publisher,
                run_id=state['run_id'],
                rounds=rounds,
                idx=idx,
                orchestrator_call_id=state['call_id'],
                log_prefix=log_prefix,
            )

            agent_results[idx] = route_result['result']
            observations.append(route_result['observation'])

        combined_observations = "\n\n".join(observations)
        state['current_session'].append({
            "role": "user",
            "content": combined_observations,
        })
        if publisher:
            publisher.react_intermediate(
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
        publisher = state.get('publisher')
        self.logger.warning(f"{log_prefix} 既没有调用 Agent 也没有给出最终答案")
        state['current_session'].append({
            "role": "user",
            "content": "请直接输出 <final_answer> 或 <tools>。",
        })
        if publisher:
            publisher.react_intermediate(
                role="user",
                content=state['current_session'][-1]["content"],
                round=rounds,
                msg_type="observation",
            )

    def _handle_final_answer(
        self,
        final_answer: str,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        del context
        publisher = state.get('publisher')
        call_id = state.get('call_id')
        if publisher:
            publisher.final_answer(final_answer)
            if call_id:
                publisher.agent_call_end(
                    call_id=call_id,
                    agent_name=self.name,
                    result=final_answer,
                    success=True,
                    agent_display_name=self.display_name or self.name,
                )
        state['_run_status'] = 'success'
        state['_run_summary'] = (
            f"任务完成，共 {state.get('rounds', 0)} 轮推理，"
            f"{len(state.get('agent_calls_history', []))} 次Agent调用"
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
        publisher = state.get('publisher')
        call_id = state.get('call_id')
        if publisher:
            publisher.final_answer(final_content)
            if call_id:
                publisher.agent_call_end(
                    call_id=call_id,
                    agent_name=self.name,
                    result=final_content,
                    success=False,
                    agent_display_name=self.display_name or self.name,
                )
            publisher.session_end(summary=f"达到最大轮数 {self.max_rounds}")
        state['_run_status'] = 'max_rounds'
        state['_run_summary'] = f"达到最大轮数 {self.max_rounds}"
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
        publisher = state.get('publisher')
        self.logger.info(f"任务被用户中断: {error}")
        call_id = state.get('call_id')
        if publisher:
            if call_id:
                publisher.agent_call_end(
                    call_id=call_id,
                    agent_name=self.name,
                    result="[已停止生成]",
                    success=False,
                    agent_display_name=self.display_name or self.name,
                )
            publisher.agent_error(error=str(error), error_type="InterruptedError")
        state['_run_status'] = 'interrupted'
        state['_run_summary'] = '用户中断执行'
        return AgentResponse(
            success=False,
            content="[已停止生成]",
            error="interrupted",
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def _handle_llm_error(
        self,
        error_message: str,
        context: AgentContext,
        state: Dict[str, Any],
        start_time: float,
    ) -> AgentResponse:
        del context
        publisher = state.get('publisher')
        call_id = state.get('call_id')
        if publisher:
            publisher.agent_error(error=error_message, error_type="LLMError")
            if call_id:
                publisher.agent_call_end(
                    call_id=call_id,
                    agent_name=self.name,
                    result=error_message,
                    success=False,
                    agent_display_name=self.display_name or self.name,
                )
        state['_run_status'] = 'error'
        state['_run_summary'] = error_message
        return AgentResponse(
            success=False,
            error=error_message,
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
        publisher = state.get('publisher')
        self.logger.error(f"执行任务失败: {error}", exc_info=True)
        call_id = state.get('call_id')
        if publisher:
            if call_id:
                publisher.agent_call_end(
                    call_id=call_id,
                    agent_name=self.name,
                    result=str(error),
                    success=False,
                )
            publisher.agent_error(error=str(error), error_type="ExecutionError")
        state['_run_status'] = 'error'
        state['_run_summary'] = f"执行失败: {error}"
        return AgentResponse(
            success=False,
            error=str(error),
            agent_name=self.name,
            execution_time=time.time() - start_time,
        )

    def can_handle(self, task: str, context: Optional[AgentContext] = None) -> bool:
        return True
