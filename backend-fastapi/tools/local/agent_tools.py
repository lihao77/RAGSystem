# -*- coding: utf-8 -*-
"""agent delegation 工具模块。"""

from __future__ import annotations

import logging
import uuid

from agents.core import AgentContext
from agents.events import EventPublisher
from agents.implementations.orchestrator.executor import AgentExecutor
from tools.decorators import tool
from tools.contracts.permissions import RiskLevel
from tools.runtime.response_builder import error_result, success_result

logger = logging.getLogger(__name__)


@tool(
    name="call_agent",
    source="agent",
    description=(
        "委派当前任务的一部分给指定子 Agent。"
        "agent_name 必须从当前提示词列出的可委派名单中选择；"
        "task 必须写入完成任务所需的完整上下文；"
        "context_hint 可补充约束、口径和输出格式。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "agent_name": {
                "type": "string",
                "description": "目标子 Agent 名称，必须来自当前可委派名单",
            },
            "task": {
                "type": "string",
                "description": "委派给子 Agent 的完整任务描述，需包含必要上下文",
            },
            "context_hint": {
                "type": "string",
                "description": "可选的补充背景、约束或输出格式要求",
            },
        },
        "required": ["agent_name", "task"],
    },
    risk_level=RiskLevel.LOW,
    requires_approval=False,
    timeout_seconds=0,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "成功时返回子 Agent 的主要结果内容",
        "shape": {
            "content": "agent_defined",
            "metadata": {
                "agent_name": "string",
                "agent_call_id": "string",
            },
        },
    },
    usage_contract=[
        "agent_name 必须从当前可委派名单中选择",
        "task 必须包含子 Agent 完成任务所需的完整上下文",
        "context_hint 用于补充约束、输出格式或口径",
        "链式传递时优先引用 result_N.content",
    ],
)
def call_agent(
    agent_name: str,
    task: str,
    context_hint: str | None = None,
    *,
    agent_config=None,
    event_bus=None,
    session_id: str | None = None,
    run_id: str | None = None,
    cancel_event=None,
    parent_call_id: str | None = None,
):
    from services.agent_api_runtime_service import get_agent_api_runtime_service

    current_agent_name = getattr(agent_config, "agent_name", None)
    delegation = getattr(agent_config, "delegation", None)
    allowed_agents = list(getattr(delegation, "enabled_agents", []) or [])

    if not allowed_agents:
        return error_result("当前 Agent 未启用子 Agent 委派能力", tool_name="call_agent")
    if agent_name not in allowed_agents:
        return error_result(
            f"目标 Agent '{agent_name}' 不在当前 allowlist 中",
            tool_name="call_agent",
        )
    if current_agent_name and agent_name == current_agent_name:
        return error_result("不允许委派给自身", tool_name="call_agent")

    runtime = get_agent_api_runtime_service()
    config_manager = runtime.get_config_manager()
    target_config = config_manager.get_config(agent_name)
    if target_config is None:
        return error_result(f"目标 Agent '{agent_name}' 不存在", tool_name="call_agent")
    if not getattr(target_config, "enabled", True):
        return error_result(f"目标 Agent '{agent_name}' 当前未启用", tool_name="call_agent")

    orchestrator = runtime.create_execution_orchestrator(session_id=session_id)
    target_agent = getattr(orchestrator, "agents", {}).get(agent_name)
    if target_agent is None:
        return error_result(f"目标 Agent '{agent_name}' 未成功加载", tool_name="call_agent")

    agent_call_id = f"call_{uuid.uuid4()}"
    publisher = None
    if event_bus is not None:
        publisher = EventPublisher(
            agent_name=current_agent_name or "call_agent",
            session_id=session_id,
            event_bus=event_bus,
            parent_call_id=parent_call_id,
        )
        publisher.agent_call_start(
            call_id=agent_call_id,
            agent_name=agent_name,
            description=task,
            parent_call_id=parent_call_id,
            agent_display_name=getattr(target_config, "display_name", None),
        )

    child_context = AgentContext(session_id=session_id or str(uuid.uuid4()))
    child_context.metadata["call_id"] = agent_call_id
    child_context.metadata["parent_call_id"] = parent_call_id
    if run_id:
        child_context.metadata["run_id"] = run_id
    if event_bus is not None:
        child_context.metadata["event_bus"] = event_bus
    if cancel_event is not None:
        child_context.metadata["cancel_event"] = cancel_event

    executor = AgentExecutor(orchestrator)
    agent_result = executor.execute_agent(
        agent_name=agent_name,
        task=task,
        context=child_context,
        context_hint=context_hint,
    )

    if publisher is not None:
        publisher.agent_call_end(
            call_id=agent_call_id,
            agent_name=agent_name,
            result=agent_result.content if agent_result.success else agent_result.content,
            success=agent_result.success,
            parent_call_id=parent_call_id,
        )

    if not agent_result.success:
        result = error_result(
            str(agent_result.content or agent_result.summary or f"Agent '{agent_name}' 执行失败"),
            tool_name="call_agent",
        )
        result.metadata.update({
            "agent_name": agent_name,
            "agent_call_id": agent_call_id,
        })
        return result

    result = success_result(
        content=agent_result.content,
        summary=agent_result.summary,
        output_type=agent_result.output_type,
        metadata={
            **(agent_result.metadata or {}),
            "agent_name": agent_name,
            "agent_call_id": agent_call_id,
        },
        tool_name="call_agent",
    )
    if agent_result.artifacts:
        result.artifacts = list(agent_result.artifacts)
    if agent_result.answer is not None:
        result.answer = agent_result.answer
    if agent_result.llm_hint is not None:
        result.llm_hint = agent_result.llm_hint
    return result
