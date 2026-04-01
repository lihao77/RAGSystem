# -*- coding: utf-8 -*-
"""builtin 工具模块。"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Optional

from agents.events import EventType
from agents.events.bus import Event
from agents.task_registry import get_task_registry
from tools.decorators import tool
from tools.contracts.permissions import RiskLevel
from tools.runtime.response_builder import success_result
from utils.timeout_pause import pause_current, resume_current

logger = logging.getLogger(__name__)


@tool(
    name="request_user_input",
    source="builtin",
    description=(
        "当你需要用户提供额外信息才能继续完成任务时使用此工具。"
        "调用后系统会暂停执行并向用户展示输入对话框，等待用户填写后继续。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "向用户展示的问题或说明，应清晰描述需要什么信息",
            },
            "input_type": {
                "type": "string",
                "enum": ["text", "select"],
                "description": "输入类型：text 为自由输入，select 为从 options 中选择",
            },
            "options": {
                "type": "array",
                "items": {"type": "string"},
                "description": "当 input_type=select 时提供的选项列表",
            },
        },
        "required": ["prompt"],
    },
    risk_level=RiskLevel.LOW,
    timeout_seconds=0,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "成功时返回用户输入内容",
        "shape": {
            "content": "string",
            "metadata": {
                "input_type": "string",
                "degraded": "boolean",
            },
        },
    },
    usage_contract=[
        "仅在缺少关键用户输入且无法通过工具补齐时使用",
        "等待用户输入期间不会计入工具超时",
        "无 session_id 时会降级返回空字符串",
    ],
)
def request_user_input(
    prompt: str,
    input_type: str = "text",
    options: list[str] | None = None,
    *,
    event_bus=None,
    session_id: Optional[str] = None,
    tool_call_id: Optional[str] = None,
    current_agent_name: Optional[str] = None,
    cancel_event=None,
):
    options = list(options or [])
    resolved_tool_call_id = tool_call_id or f"tool_{uuid.uuid4()}"
    input_id = str(uuid.uuid4())

    registry = get_task_registry()
    wait_evt = registry.add_pending_input(session_id, input_id) if session_id else None

    if event_bus:
        event_bus.publish(Event(
            type=EventType.USER_INPUT_REQUIRED,
            session_id=session_id,
            agent_name=current_agent_name,
            data={
                "input_id": input_id,
                "tool_call_id": resolved_tool_call_id,
                "prompt": prompt,
                "input_type": input_type,
                "options": options,
            },
        ))

    logger.info(
        "[request_user_input] 等待用户输入 session_id=%s input_id=%s prompt=%r",
        session_id,
        input_id,
        prompt[:60],
    )

    if wait_evt is None:
        logger.warning("request_user_input: 缺少 session_id，降级返回空字符串")
        return success_result(
            content="",
            summary="当前上下文缺少 session_id，未等待用户输入",
            output_type="text",
            metadata={
                "input_type": input_type,
                "options": options,
                "degraded": True,
            },
            tool_name="request_user_input",
        )

    started_at = time.time()
    pause_current()
    try:
        wait_evt.wait()
    finally:
        resume_current()

    value = registry.get_input_result(session_id, input_id)
    if value == "" and cancel_event is not None and getattr(cancel_event, "is_set", lambda: False)():
        logger.info("request_user_input: 等待期间任务被取消 input_id=%s", input_id)

    logger.info("[request_user_input] 用户输入已接收 input_id=%s", input_id)
    return success_result(
        content=value or "",
        summary="用户输入已接收",
        output_type="text",
        metadata={
            "input_type": input_type,
            "options": options,
            "degraded": False,
            "waited_seconds": time.time() - started_at,
        },
        tool_name="request_user_input",
    )
