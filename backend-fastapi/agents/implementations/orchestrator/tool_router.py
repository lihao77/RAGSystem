# -*- coding: utf-8 -*-
"""
OrchestratorAgent 工具路由器。

统一将 request_user_input、call_agent 与 direct 工具都交给 dispatcher 分发。
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Dict

from tools.runtime.response_builder import error_result
from tools.tool_registry import get_tool_registry

if TYPE_CHECKING:
    from agents.core.context import AgentContext
    from agents.events.bus import EventBus
    from agents.events.publisher import EventPublisher


_TOOL_REGISTRY = get_tool_registry()


def _format_tool_observation(
    agent,
    result,
    *,
    tool_name: str,
    session_id: str | None,
    is_skills_tool: bool,
) -> str:
    return agent._format_tool_observation(
        result,
        tool_name=tool_name,
        session_id=session_id,
        is_skills_tool=is_skills_tool,
    )


def route_direct_tool(
    agent,
    action: Dict[str, object],
    context: AgentContext,
    event_bus: EventBus,
    publisher: EventPublisher | None,
    run_id: str,
    rounds: int,
    idx: int,
    orchestrator_call_id: str,
    log_prefix: str,
) -> Dict[str, object]:
    from tools.refs.result_references import result_event_payload, result_success

    tool_name = action.get('tool')
    arguments = action.get('arguments', {})

    available_tool_names = {
        t.get('function', {}).get('name') for t in agent.available_tools
    }
    is_skills_tool = tool_name in _TOOL_REGISTRY.get_skill_tool_names()

    if tool_name not in available_tool_names:
        error_msg = f"无效的工具名称: {tool_name}（未在当前 Agent 可用工具列表中）"
        agent.logger.warning(f"{log_prefix} {error_msg}")
        return {
            'observation': f"[{tool_name}]\n错误: {error_msg}",
            'result': error_result(error_msg, tool_name=tool_name),
            'visualization_event': None,
        }

    tool_call_id = action.get('tool_call_id') or f"call_{run_id}_{rounds}_{idx}_tool"
    if publisher:
        publisher.tool_call_start(
            call_id=tool_call_id,
            tool_name=tool_name,
            arguments=arguments,
            parent_call_id=orchestrator_call_id,
            round=rounds,
            agent_display_name=getattr(agent, 'display_name', None) or getattr(agent, 'name', None),
        )

    tool_start_time = time.time()
    try:
        from tools.runtime.executor import execute_tool as _execute_tool
        result = _execute_tool(
            tool_name,
            arguments,
            agent_config=agent.agent_config,
            event_bus=event_bus,
            session_id=context.session_id,
            run_id=context.metadata.get('run_id') if hasattr(context, 'metadata') else None,
            cancel_event=context.metadata.get('cancel_event') if hasattr(context, 'metadata') else None,
            parent_call_id=orchestrator_call_id,
            current_agent_name=getattr(agent, 'name', None),
            tool_call_id=tool_call_id,
            round=rounds,
            order=idx,
            round_index=idx,
        )
    except Exception as tool_exc:
        agent.logger.error(f"{log_prefix} 工具 {tool_name} 执行异常: {tool_exc}", exc_info=True)
        result = error_result(str(tool_exc), tool_name=tool_name)
    tool_elapsed = time.time() - tool_start_time

    observation = _format_tool_observation(
        agent,
        result,
        tool_name=tool_name,
        session_id=context.session_id,
        is_skills_tool=is_skills_tool,
    )
    if observation:
        observation = f"[{tool_name}]\n{observation}"

    if publisher:
        publisher.tool_call_end(
            call_id=tool_call_id,
            tool_name=tool_name,
            result=observation or '',
            result_preview=observation or '',
            raw_result=result_event_payload(result),
            raw_result_ref={
                'session_id': context.session_id,
                'call_id': tool_call_id,
                'tool_name': tool_name,
            },
            execution_time=tool_elapsed,
            parent_call_id=orchestrator_call_id,
            success=result_success(result),
            round=rounds,
            agent_display_name=getattr(agent, 'display_name', None) or getattr(agent, 'name', None),
        )

    return {
        'observation': observation,
        'result': result,
        'visualization_event': None,
    }
