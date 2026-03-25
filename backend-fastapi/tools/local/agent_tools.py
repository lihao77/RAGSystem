# -*- coding: utf-8 -*-
"""agent delegation 工具模块。"""

from __future__ import annotations

import logging
import uuid

from agents.events import EventPublisher
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
        "call_agent 用于创建新的子 Agent 会话；如需继续既有子 Agent，请使用 send_message(child_agent_id, message)",
        "链式传递时优先引用 result_N.content 或 result_N.metadata.child_agent_id",
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
    effective_session_id = session_id or str(uuid.uuid4())
    config_manager = runtime.get_config_manager()
    execution_service = runtime.get_agent_execution_service()
    target_config = config_manager.get_config(agent_name)
    if target_config is None:
        return error_result(f"目标 Agent '{agent_name}' 不存在", tool_name="call_agent")
    if not getattr(target_config, "enabled", True):
        return error_result(f"目标 Agent '{agent_name}' 当前未启用", tool_name="call_agent")

    child_agent_id = f"child_{uuid.uuid4()}"
    resolved_thread_key = f"child:{child_agent_id}"

    orchestrator = runtime.create_execution_orchestrator(session_id=effective_session_id)
    if getattr(orchestrator, "agents", {}).get(agent_name) is None:
        return error_result(f"目标 Agent '{agent_name}' 未成功加载", tool_name="call_agent")

    agent_call_id = f"call_{uuid.uuid4()}"
    publisher = None
    if event_bus is not None:
        publisher = EventPublisher(
            agent_name=current_agent_name or "call_agent",
            session_id=effective_session_id,
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

    store = runtime.get_conversation_store()
    anchor_message = store.add_message(
        session_id=effective_session_id,
        role='assistant',
        content='',
        metadata={
            'agent': current_agent_name or 'call_agent',
            'msg_type': 'child_agent_anchor',
            'react_intermediate': True,
            'visible_to_user': False,
            'conversation_scope': 'root',
        },
        thread_key='root',
    )
    store.create_child_agent(
        child_agent_id=child_agent_id,
        session_id=effective_session_id,
        agent_name=agent_name,
        thread_key=resolved_thread_key,
        created_seq=anchor_message.get('seq'),
        created_by_run_id=run_id,
        created_by_call_id=agent_call_id,
        parent_run_id=run_id,
        parent_call_id=parent_call_id,
        metadata={"created_via": "call_agent"},
    )

    agent_result = execution_service.execute_agent_call(
        agent_name=agent_name,
        task=task,
        session_id=effective_session_id,
        user_id=None,
        context_hint=context_hint,
        request_id=None,
        parent_run_id=run_id,
        parent_call_id=agent_call_id,
        event_bus=event_bus,
        cancel_event=cancel_event,
        child_agent_id=child_agent_id,
        history_limit=50,
        entrypoint='call_agent',
        source='agent_call',
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
            "child_agent_id": child_agent_id,
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
            "child_agent_id": child_agent_id,
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


@tool(
    name="list_child_agents",
    source="agent",
    description=(
        "列出当前 session 下已创建的子 Agent 会话，便于找回 child_agent_id。"
        "可按 agent_name 过滤，并返回最近创建的 child_agent_id 列表。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "agent_name": {
                "type": "string",
                "description": "可选的 Agent 名称过滤条件，只返回该 agent 的 child 会话",
            },
            "limit": {
                "type": "integer",
                "description": "返回条数上限，默认 20",
                "minimum": 1,
                "maximum": 100,
            },
        },
    },
    risk_level=RiskLevel.LOW,
    requires_approval=False,
    timeout_seconds=0,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "成功时返回 child agent 列表，便于后续 send_message 续接",
        "shape": {
            "items": [
                {
                    "child_agent_id": "string",
                    "agent_name": "string",
                    "status": "string",
                    "last_run_id": "string|null",
                }
            ],
            "total": "integer",
        },
    },
    usage_contract=[
        "当不知道之前的 child_agent_id 时，可先调用 list_child_agents 再决定是否 send_message",
        "agent_name 可用于缩小范围，只查看某个子 Agent 的历史会话",
        "返回结果中的 child_agent_id 可直接作为 send_message(child_agent_id, message) 的输入",
    ],
)
def list_child_agents(
    agent_name: str | None = None,
    limit: int = 20,
    *,
    agent_config=None,
    event_bus=None,
    session_id: str | None = None,
    run_id: str | None = None,
    cancel_event=None,
    parent_call_id: str | None = None,
):
    del agent_config, event_bus, run_id, cancel_event, parent_call_id
    from services.agent_api_runtime_service import get_agent_api_runtime_service

    runtime = get_agent_api_runtime_service()
    store = runtime.get_conversation_store()
    effective_session_id = session_id or str(uuid.uuid4())
    resolved_limit = max(1, min(int(limit or 20), 100))
    result = store.list_child_agents(
        session_id=effective_session_id,
        agent_name=agent_name,
        limit=resolved_limit,
    )
    items = [
        {
            "child_agent_id": item.get("child_agent_id"),
            "agent_name": item.get("agent_name"),
            "status": item.get("status"),
            "last_run_id": item.get("last_run_id"),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }
        for item in result.get("items", [])
    ]
    summary = f"找到 {len(items)} 个 child agent"
    if agent_name:
        summary = f"找到 {len(items)} 个 {agent_name} child agent"
    return success_result(
        content={"items": items, "total": result.get("total", len(items))},
        summary=summary,
        output_type="json",
        metadata={
            "agent_name": agent_name,
            "session_id": effective_session_id,
        },
        tool_name="list_child_agents",
    )


@tool(
    name="send_message",
    source="agent",
    description=(
        "向已存在的子 Agent 会话发送一条新消息，并续接该子 Agent 的上下文继续执行。"
        "child_agent_id 必须来自之前 call_agent 返回的 metadata.child_agent_id；"
        "message 应描述本轮追加任务或修正要求。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "child_agent_id": {
                "type": "string",
                "description": "要续接的子 Agent 会话 ID，来自之前 call_agent 返回的 metadata.child_agent_id",
            },
            "message": {
                "type": "string",
                "description": "发送给该子 Agent 的新消息内容",
            },
        },
        "required": ["child_agent_id", "message"],
    },
    risk_level=RiskLevel.LOW,
    requires_approval=False,
    timeout_seconds=0,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "成功时返回该子 Agent 本轮续接执行的结果",
        "shape": {
            "content": "agent_defined",
            "metadata": {
                "agent_name": "string",
                "child_agent_id": "string",
                "run_id": "string",
            },
        },
    },
    usage_contract=[
        "child_agent_id 必须来自之前 call_agent 返回的 metadata.child_agent_id",
        "message 应只表达本轮追加要求，而不是重新描述整个初始任务",
        "如需创建新的子 Agent 会话，请使用 call_agent",
    ],
)
def send_message(
    child_agent_id: str,
    message: str,
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
    runtime = get_agent_api_runtime_service()
    store = runtime.get_conversation_store()
    execution_service = runtime.get_agent_execution_service()

    effective_session_id = session_id or str(uuid.uuid4())
    child_agent = store.get_child_agent(session_id=effective_session_id, child_agent_id=child_agent_id)
    if child_agent is None:
        return error_result(f"子 Agent '{child_agent_id}' 不存在", tool_name="send_message")
    if child_agent.get("status") != "active":
        return error_result(f"子 Agent '{child_agent_id}' 当前不可用", tool_name="send_message")

    agent_name = child_agent.get("agent_name")
    config_manager = runtime.get_config_manager()
    target_config = config_manager.get_config(agent_name)
    if target_config is None:
        return error_result(f"目标 Agent '{agent_name}' 不存在", tool_name="send_message")
    if not getattr(target_config, "enabled", True):
        return error_result(f"目标 Agent '{agent_name}' 当前未启用", tool_name="send_message")

    child_call_id = f"call_{uuid.uuid4()}"
    publisher = None
    if event_bus is not None:
        publisher = EventPublisher(
            agent_name=current_agent_name or "send_message",
            session_id=effective_session_id,
            event_bus=event_bus,
            parent_call_id=parent_call_id,
        )
        publisher.agent_call_start(
            call_id=child_call_id,
            agent_name=agent_name,
            description=message,
            parent_call_id=parent_call_id,
            agent_display_name=getattr(target_config, "display_name", None),
        )

    store.add_message(
        session_id=effective_session_id,
        role='user',
        content=message,
        metadata={
            'agent': agent_name,
            'run_id': run_id,
            'child_agent_id': child_agent_id,
            'thread_key': child_agent.get('thread_key'),
            'conversation_scope': 'child',
            'visible_to_user': False,
        },
        thread_key=child_agent.get('thread_key'),
        child_agent_id=child_agent_id,
    )

    agent_result = execution_service.execute_agent_call(
        agent_name=agent_name,
        task=message,
        session_id=effective_session_id,
        user_id=None,
        context_hint=None,
        request_id=None,
        parent_run_id=run_id,
        parent_call_id=child_call_id,
        event_bus=event_bus,
        cancel_event=cancel_event,
        child_agent_id=child_agent_id,
        history_limit=50,
        entrypoint='send_message',
        source='agent_call',
    )

    if publisher is not None:
        publisher.agent_call_end(
            call_id=child_call_id,
            agent_name=agent_name,
            result=agent_result.content if agent_result.success else agent_result.content,
            success=agent_result.success,
            parent_call_id=parent_call_id,
        )

    if not agent_result.success:
        result = error_result(
            str(agent_result.content or agent_result.summary or f"Agent '{agent_name}' 执行失败"),
            tool_name="send_message",
        )
        result.metadata.update({
            "agent_name": agent_name,
            "child_agent_id": child_agent_id,
            "agent_call_id": child_call_id,
        })
        return result

    result = success_result(
        content=agent_result.content,
        summary=agent_result.summary,
        output_type=agent_result.output_type,
        metadata={
            **(agent_result.metadata or {}),
            "agent_name": agent_name,
            "child_agent_id": child_agent_id,
            "agent_call_id": child_call_id,
        },
        tool_name="send_message",
    )
    if agent_result.artifacts:
        result.artifacts = list(agent_result.artifacts)
    if agent_result.answer is not None:
        result.answer = agent_result.answer
    if agent_result.llm_hint is not None:
        result.llm_hint = agent_result.llm_hint
    return result
