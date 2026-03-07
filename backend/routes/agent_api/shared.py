# -*- coding: utf-8 -*-
"""
Agent API 共享状态与辅助函数。
"""

import asyncio
import json
import logging
import uuid as uuid_module

from flask import Blueprint, Response, request, stream_with_context

from agents import (
    AgentContext,
    get_config_manager,
)
from agents.context.manager import ContextManager
from agents.core.models import Message
from agents.events import EventType, SSEAdapter, get_session_event_bus
from agents.events.bus import Event
from agents.task_registry import get_task_registry
from config import get_config
from conversation_store import ConversationStore
from model_adapter import get_default_adapter
from services.agent_runtime_service import get_agent_runtime_service
from utils.response_helpers import error_response, success_response

logger = logging.getLogger(__name__)

agent_bp = Blueprint('agent', __name__)

_conversation_store = None

def _get_conversation_store() -> ConversationStore:
    global _conversation_store
    if _conversation_store is None:
        _conversation_store = ConversationStore()
    return _conversation_store

def _load_history_into_context(context: AgentContext, session_id: str, limit: int = 50):
    """
    加载完整原始上下文（含 seq）到 context。

    压缩判断与持久化由 Agent 内部统一处理，Route 只负责：
    1. 加载原始消息
    2. 订阅 COMPRESSION_SUMMARY 事件并写 DB
    """
    store = _get_conversation_store()
    raw = store.get_recent_messages(session_id=session_id, limit=limit)

    for item in raw:
        if item.get("role") in ["user", "assistant", "system"]:
            meta = dict(item.get("metadata") or {})
            if item.get("seq") is not None:
                meta["seq"] = item["seq"]
            context.add_message(role=item["role"], content=item["content"], metadata=meta)

def _get_orchestrator():
    """获取或初始化全局 Orchestrator。"""
    return get_agent_runtime_service().get_orchestrator()

def reload_agents():
    """重新加载 orchestrator 中的智能体。"""
    return get_agent_runtime_service().reload_agents()

__all__ = ['agent_bp', 'reload_agents', 'logger', 'request', 'Response', 'stream_with_context', 'json', 'asyncio', 'uuid_module', 'AgentContext', 'ContextManager', 'Message', 'EventType', 'get_session_event_bus', 'SSEAdapter', 'Event', 'get_config_manager', 'get_default_adapter', 'get_config', 'success_response', 'error_response', 'get_task_registry', '_get_conversation_store', '_load_history_into_context', '_get_orchestrator']
