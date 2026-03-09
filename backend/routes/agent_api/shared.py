# -*- coding: utf-8 -*-
"""
Agent API 共享状态与辅助函数。
"""

import asyncio
import json
import logging
import uuid as uuid_module

from flask import Blueprint, Response, request, stream_with_context

from agents import AgentContext
from agents.context.manager import ContextManager
from agents.core.models import Message
from agents.events import EventType, SSEAdapter
from agents.events.bus import Event
from services.agent_api_runtime_service import get_agent_api_runtime_service
from utils.response_helpers import error_response, success_response

logger = logging.getLogger(__name__)

agent_bp = Blueprint('agent', __name__)

def _get_conversation_store():
    return get_agent_api_runtime_service().get_conversation_store()

def get_chat_application():
    return get_agent_api_runtime_service().get_chat_application()

def get_session_application():
    return get_agent_api_runtime_service().get_session_application()

def get_collaboration_application():
    return get_agent_api_runtime_service().get_collaboration_application()


def _load_history_into_context(context: AgentContext, session_id: str, limit: int = 50):
    """
    加载完整原始上下文（含 seq）到 context。

    压缩判断与持久化由 Agent 内部统一处理，Route 只负责：
    1. 加载原始消息
    2. 订阅 COMPRESSION_SUMMARY 事件并写 DB
    """
    return get_agent_api_runtime_service().load_history_into_context(context, session_id=session_id, limit=limit)


def _get_orchestrator():
    """获取或初始化全局 Orchestrator。"""
    return get_agent_api_runtime_service().get_orchestrator()


def reload_agents():
    """重新加载 orchestrator 中的智能体。"""
    return get_agent_api_runtime_service().reload_agents()


def get_config():
    return get_agent_api_runtime_service().get_system_config()


def get_config_manager():
    return get_agent_api_runtime_service().get_config_manager()


def get_task_registry():
    return get_agent_api_runtime_service().get_task_registry()


def get_session_event_bus(session_id: str):
    return get_agent_api_runtime_service().get_session_event_bus(session_id)


def get_default_adapter():
    return get_agent_api_runtime_service().get_default_adapter()

__all__ = ['agent_bp', 'reload_agents', 'logger', 'request', 'Response', 'stream_with_context', 'json', 'asyncio', 'uuid_module', 'AgentContext', 'ContextManager', 'Message', 'EventType', 'get_session_event_bus', 'SSEAdapter', 'Event', 'get_config_manager', 'get_default_adapter', 'get_config', 'success_response', 'error_response', 'get_task_registry', 'get_chat_application', 'get_session_application', 'get_collaboration_application', '_get_conversation_store', '_load_history_into_context', '_get_orchestrator']
