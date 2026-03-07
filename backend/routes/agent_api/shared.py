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
    get_orchestrator,
    load_agents_from_config,
)
from agents.context.manager import ContextManager
from agents.core.models import Message
from agents.events import EventType, SSEAdapter, get_session_event_bus
from agents.events.bus import Event
from agents.task_registry import get_task_registry
from config import get_config
from conversation_store import ConversationStore
from model_adapter import get_default_adapter
from utils.response_helpers import error_response, success_response

logger = logging.getLogger(__name__)

agent_bp = Blueprint('agent', __name__)

_orchestrator = None
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
    """获取或初始化全局 Orchestrator（使用动态加载）"""
    global _orchestrator

    if _orchestrator is None:
        try:
            system_config = get_config()
            adapter = get_default_adapter()

            # 创建 Orchestrator
            _orchestrator = get_orchestrator(model_adapter=adapter)

            # 🎉 使用动态加载机制加载所有智能体
            agents = load_agents_from_config(
                model_adapter=adapter,
                system_config=system_config,
                orchestrator=_orchestrator
            )

            # 注册所有加载的智能体
            for agent_name, agent in agents.items():
                _orchestrator.register_agent(agent)
                logger.info(f"已注册智能体: {agent_name}")

            # 初始化性能指标收集器
            try:
                from agents.monitoring import MetricsCollector
                from agents.events import get_session_manager

                metrics_collector = MetricsCollector()

                # 获取全局会话事件总线管理器
                session_manager = get_session_manager()

                # 将 metrics_collector 附加到 orchestrator 以便后续访问
                _orchestrator._metrics_collector = metrics_collector
                _orchestrator._session_manager = session_manager

                logger.info("✓ 性能指标收集器已初始化")
            except Exception as e:
                logger.warning(f"性能指标收集器初始化失败（不影响核心功能）: {e}")

            # 验证注册结果
            registered_agents = _orchestrator.list_agents()
            logger.info(f"Orchestrator 初始化成功，已加载 {len(agents)} 个智能体，已注册 {len(registered_agents)} 个智能体")
            logger.info(f"已加载的智能体列表: {list(agents.keys())}")
            logger.info(f"已注册的智能体列表: {[a['name'] for a in registered_agents]}")
        except Exception as e:
            logger.error(f"Orchestrator 初始化失败: {e}", exc_info=True)
            raise

    return _orchestrator

def reload_agents():
    """
    重新加载 orchestrator 中的智能体（用于配置更新后刷新）

    这个函数会：
    1. 清除旧的智能体注册
    2. 重新加载所有启用的智能体
    3. 注册到 orchestrator

    Returns:
        bool: 是否重新加载成功
    """
    global _orchestrator

    if _orchestrator is None:
        logger.warning("orchestrator 未初始化，跳过重新加载")
        return False

    try:
        # 清空现有智能体（保留注册表对象）
        _orchestrator.registry.clear()
        logger.info("已清空 orchestrator 中的智能体注册")

        # 重新加载智能体
        system_config = get_config()
        adapter = get_default_adapter()

        agents = load_agents_from_config(
            model_adapter=adapter,
            system_config=system_config,
            orchestrator=_orchestrator
        )

        # 重新注册
        for agent_name, agent in agents.items():
            _orchestrator.register_agent(agent)
            logger.info(f"已重新注册智能体: {agent_name}")

        logger.info(f"智能体重新加载完成，共加载 {len(agents)} 个智能体")
        return True

    except Exception as e:
        logger.error(f"重新加载智能体失败: {e}", exc_info=True)
        return False

__all__ = ['agent_bp', 'reload_agents', 'logger', 'request', 'Response', 'stream_with_context', 'json', 'asyncio', 'uuid_module', 'AgentContext', 'ContextManager', 'Message', 'EventType', 'get_session_event_bus', 'SSEAdapter', 'Event', 'get_config_manager', 'get_default_adapter', 'get_config', 'success_response', 'error_response', 'get_task_registry', '_get_conversation_store', '_load_history_into_context', '_get_orchestrator']
