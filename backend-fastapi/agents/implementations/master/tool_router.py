# -*- coding: utf-8 -*-
"""
MasterAgent 工具路由器。

将工具调用路由到三个目标:
- 路由0: 内置伪工具 (request_user_input)
- 路由1: 委派子 Agent
- 路由2/3: 直接工具 (Skills 工具或普通工具)
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any, Dict, Optional

if TYPE_CHECKING:
    from agents.core.context import AgentContext
    from agents.events.bus import EventBus
    from agents.events.publisher import EventPublisher


def route_user_input_request(
    agent,
    action: Dict[str, Any],
    context: AgentContext,
    event_bus: EventBus,
    run_id: str,
    rounds: int,
    idx: int,
    master_call_id: str,
) -> Dict[str, Any]:
    """
    路由0: 处理 request_user_input 伪工具。

    返回: {"observation": str, "result": dict}
    """
    arguments = action.get('arguments', {})
    tool_call_id = action.get('tool_call_id') or f"call_{run_id}_{rounds}_{idx}_input"

    user_value = agent._handle_user_input_request(
        arguments=arguments,
        event_bus=event_bus,
        session_id=context.session_id,
        tool_call_id=tool_call_id,
        publisher=agent._publisher,
        parent_call_id=master_call_id,
    )

    if user_value is None:
        # 被取消（cancel_event 已设置），下一次检查中断时会退出
        agent._check_interrupt(context)
        user_value = ""

    observation = f"**工具 {idx}: request_user_input**\n用户输入: {user_value}"
    result = {"success": True, "data": {"results": user_value}}

    return {
        "observation": observation,
        "result": result,
    }


def route_agent_delegation(
    agent,
    action: Dict[str, Any],
    context: AgentContext,
    event_bus: EventBus,
    run_id: str,
    rounds: int,
    idx: int,
    master_call_id: str,
    global_agent_order: int,
    log_prefix: str,
) -> Dict[str, Any]:
    """
    路由1: 委派子 Agent 执行。

    返回: {"observation": str, "result": dict, "call_history": dict}
    """
    from .executor import parse_agent_invocation
    from agents.core.models import AgentResponse

    tool_name = action.get('tool')
    arguments = action.get('arguments', {})
    agent_name = parse_agent_invocation(tool_name)

    # 提取参数
    agent_task = arguments.get('task', '')
    context_hint = arguments.get('context_hint')

    agent.logger.info(
        f"{log_prefix} [{idx}/{len([action])}] 调用 Agent: {agent_name} "
        f"(全局顺序: {global_agent_order}, 轮次: {rounds}-{idx})"
    )
    agent.logger.info(f"{log_prefix} 任务: {agent_task[:100]}...")

    # 生成 call_id
    call_id = f"call_{run_id}_{rounds}_{idx}"
    agent_display_name = agent._get_agent_display_name(agent_name)

    # 发布 AgentCall 开始事件
    agent._publisher.agent_call_start(
        call_id=call_id,
        agent_name=agent_name,
        description=agent_task,
        parent_call_id=master_call_id,
        order=global_agent_order,
        round=rounds,
        round_index=idx
    )

    # 派生子上下文 (Context Forking)
    child_context = context.fork()
    agent.logger.info(f"{log_prefix} 已派生子上下文 (Level {child_context.level})")

    # 传递元数据
    if not hasattr(child_context, 'metadata'):
        child_context.metadata = {}
    child_context.metadata['call_id'] = call_id
    child_context.metadata['parent_call_id'] = master_call_id
    child_context.metadata['run_id'] = run_id
    child_context.metadata['task_order'] = global_agent_order

    # 传播 cancel_event
    cancel_event = context.metadata.get('cancel_event')
    if cancel_event:
        child_context.metadata['cancel_event'] = cancel_event

    # 执行 Agent
    agent_start = time.time()
    agent_result = agent.agent_executor.execute_agent(
        agent_name=agent_name,
        task=agent_task,
        context=child_context,
        context_hint=context_hint
    )
    elapsed_time = time.time() - agent_start

    # 处理结果
    if agent_result is None:
        agent_result = {
            "success": False,
            "error": "Agent 未返回结果"
        }

    # 合并子上下文 (Context Merging)
    try:
        response_obj = AgentResponse(
            success=agent_result.get('success', False),
            content=agent_result.get('data', {}).get('results', ''),
            metadata=agent_result.get('data', {}).get('metadata', {}),
            error=agent_result.get('error'),
            agent_name=agent_name
        )
        context.merge(child_context, response_obj)
        agent.logger.info(f"{log_prefix} 子上下文已合并")
    except Exception as e:
        agent.logger.warning(f"{log_prefix} 合并上下文失败: {e}")

    # 发布 AgentCall 结束事件
    agent._publisher.agent_call_end(
        call_id=call_id,
        agent_name=agent_name,
        result=agent_result.get('data', {}).get('results', ''),
        success=agent_result.get('success', False),
        parent_call_id=master_call_id,
        order=global_agent_order
    )

    # 格式化观察结果
    observation = agent.observation_formatter.format(
        agent_result,
        tool_name=agent_name,
        is_skills_tool=False
    )
    observation = f"**Agent {idx} ({agent_name})**:\n{observation}"

    # 记录调用历史
    call_history = {
        'agent_name': agent_name,
        'task': agent_task,
        'result': agent_result
    }

    return {
        "observation": observation,
        "result": agent_result,
        "call_history": call_history,
    }


def route_direct_tool(
    agent,
    action: Dict[str, Any],
    context: AgentContext,
    event_bus: EventBus,
    run_id: str,
    rounds: int,
    idx: int,
    master_call_id: str,
    log_prefix: str,
) -> Dict[str, Any]:
    """
    路由2/3: 执行直接工具 (Skills 工具或普通工具)。

    返回: {"observation": str, "result": dict, "visualization_event": Optional[dict]}
    """
    from agents.tools.builtin import SKILLS_TOOL_NAMES, BUILTIN_TOOL_NAMES

    tool_name = action.get('tool')
    arguments = action.get('arguments', {})

    # 判断工具类型
    available_tool_names = {
        t.get('function', {}).get('name') for t in agent.available_tools
    } - BUILTIN_TOOL_NAMES
    is_skills_tool = tool_name in SKILLS_TOOL_NAMES

    if not (is_skills_tool or tool_name in available_tool_names):
        # 未知工具
        error_msg = f"无效的工具名称: {tool_name}（既不是 Agent 工具也不是已配置的直接工具）"
        agent.logger.warning(f"{log_prefix} {error_msg}")
        return {
            "observation": f"**工具 {idx}**: 失败\n错误: {error_msg}",
            "result": {"success": False, "error": error_msg},
            "visualization_event": None,
        }

    agent.logger.info(
        f"{log_prefix} [{idx}] 直接执行工具: {tool_name} "
        f"({'Skills工具' if is_skills_tool else '直接工具'})"
    )

    # 发布工具调用开始事件
    tool_call_id = f"call_{run_id}_{rounds}_{idx}_tool"
    agent._publisher.tool_call_start(
        call_id=tool_call_id,
        tool_name=tool_name,
        arguments=arguments,
        parent_call_id=master_call_id,
    )

    # 执行工具
    tool_start_time = time.time()
    try:
        from tools.tool_executor import execute_tool as _execute_tool
        result = _execute_tool(
            tool_name,
            arguments,
            agent_config=agent.agent_config,
            event_bus=event_bus,
            session_id=context.session_id,
        )
    except Exception as tool_exc:
        agent.logger.error(
            f"{log_prefix} 直接工具 {tool_name} 执行异常: {tool_exc}",
            exc_info=True
        )
        result = {
            "success": False,
            "error": str(tool_exc)
        }

    tool_elapsed = time.time() - tool_start_time

    # 发布工具调用结束事件
    tool_result_for_event = result.get('data', result) if isinstance(result, dict) else result
    agent._publisher.tool_call_end(
        call_id=tool_call_id,
        tool_name=tool_name,
        result=tool_result_for_event,
        execution_time=tool_elapsed,
        parent_call_id=master_call_id,
    )

    # 处理可视化事件
    visualization_event = None
    if tool_name == 'generate_chart' and result.get('success'):
        results = result.get('data', {}).get('results', {})
        chart_config = results.get('echarts_config')
        chart_type = results.get('chart_type', 'bar')
        if chart_config:
            visualization_event = {
                'type': 'chart',
                'chart_config': chart_config,
                'chart_type': chart_type,
            }
    elif tool_name == 'generate_map' and result.get('success'):
        results = result.get('data', {}).get('results', {})
        map_type = results.get('map_type', 'marker')
        if results:
            visualization_event = {
                'type': 'map',
                'map_data': results,
                'map_type': map_type,
            }

    # 格式化观察结果
    observation = agent.observation_formatter.format(
        result,
        tool_name=tool_name,
        is_skills_tool=is_skills_tool
    )
    observation = f"**工具 {idx} ({tool_name})**:\n{observation}"

    return {
        "observation": observation,
        "result": result,
        "visualization_event": visualization_event,
    }
