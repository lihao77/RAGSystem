# -*- coding: utf-8 -*-
"""
消息路由器。

负责将社交平台入站消息路由到对应 Agent 执行，
通过 EventBus + TaskRegistry + DaemonApprovalHandler
实现与 Web 会话完全对等的执行流程。
"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from typing import TYPE_CHECKING, Dict, Optional

from daemon.models import (
    IncomingMessage,
    OutgoingMessage,
)

if TYPE_CHECKING:
    from daemon.approval_handler import DaemonApprovalHandler
    from daemon.service import DaemonService

logger = logging.getLogger(__name__)


class MessageRouter:
    """统一消息路由器。"""

    def __init__(self, daemon_service: DaemonService):
        self._daemon_service = daemon_service
        # chat_id → 活跃的审批处理器
        self._approval_handlers: Dict[str, DaemonApprovalHandler] = {}

    async def route_incoming(self, message: IncomingMessage) -> None:
        """
        路由入站消息到 Agent 执行。

        流程：
        0. 检查是否有待审批请求 → 尝试作为审批回复消费
        1. 解析 session_id + agent 配置
        2. 创建 EventBus + 注册 TaskRegistry
        3. 创建并订阅 DaemonApprovalHandler
        4. 通过 AgentExecutionService 执行 Agent（传入 event_bus）
        5. 回送响应到来源平台
        6. 清理资源
        """
        logger.info(
            '收到消息 [%s] chat=%s user=%s: %s',
            message.platform.value,
            message.chat_id,
            message.user_id,
            message.content[:100],
        )

        try:
            # ── 0. 审批回复拦截 ──
            handler = self._approval_handlers.get(message.chat_id)
            if handler and handler.has_pending(message.chat_id):
                resolved = handler.try_resolve_from_message(message)
                if resolved:
                    logger.info('消息被当作审批回复处理: chat_id=%s', message.chat_id)
                    return

            # ── 1. 解析 session_id + agent 配置 ──
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            if not container:
                logger.error('RuntimeContainer 未初始化，无法路由消息')
                return

            runtime_svc = container.get_agent_api_runtime_service()
            exec_svc = runtime_svc.get_agent_execution_service()

            session_id, agent_config = self._daemon_service.resolve_session_id_for_message(message)
            entry_agent = agent_config.entry_agent

            # ── 2. 创建 EventBus + 注册 TaskRegistry ──
            from agents.events.bus import EventType
            from agents.task_registry import get_task_registry

            run_id = str(uuid.uuid4())
            session_manager = container.get_session_manager()
            event_bus = session_manager.get_or_create(run_id, session_id=session_id)

            registry = get_task_registry()
            cancel_event = threading.Event()
            task_id = registry.register_task(
                session_id=session_id,
                run_id=run_id,
                task=message.content[:200],
                cancel_event=cancel_event,
                status='starting',
                execution_kind='daemon_message',
                concurrency_key=f'session:{session_id}',
            )
            if task_id is None:
                logger.warning('session %s 正在执行任务，消息无法并发处理', session_id)
                await self._daemon_service.send_message(OutgoingMessage(
                    platform=message.platform,
                    chat_id=message.chat_id,
                    content='⏳ 上一个任务仍在执行中，请稍后再试。',
                ))
                return

            # ── 3. 创建 + 订阅审批处理器 ──
            from daemon.approval_handler import DaemonApprovalHandler
            from daemon.models import DaemonPermissionConfig

            permission_config = getattr(agent_config, 'permissions', None)
            if permission_config is None:
                permission_config = DaemonPermissionConfig()

            approval_handler = DaemonApprovalHandler(
                daemon_service=self._daemon_service,
                session_id=session_id,
                platform=message.platform,
                chat_id=message.chat_id,
                permission_config=permission_config,
                main_loop=asyncio.get_running_loop(),
            )
            event_bus.subscribe(
                event_types=[EventType.USER_APPROVAL_REQUIRED],
                handler=approval_handler.on_approval_required,
            )
            self._approval_handlers[message.chat_id] = approval_handler

            # ── 4. 执行 Agent（传入 event_bus + run_id + cancel_event）──
            try:
                if entry_agent:
                    result = await asyncio.to_thread(
                        exec_svc.invoke_agent,
                        mode='root',
                        agent_name=entry_agent,
                        task=message.content,
                        session_id=session_id,
                        event_bus=event_bus,
                        run_id=run_id,
                        cancel_event=cancel_event,
                        source=f'daemon.{message.platform.value}',
                        persist_user_message=True,
                        persist_final_answer=True,
                    )
                else:
                    result = await asyncio.to_thread(
                        exec_svc.invoke_routed_agent,
                        task=message.content,
                        session_id=session_id,
                        event_bus=event_bus,
                        run_id=run_id,
                        cancel_event=cancel_event,
                        preferred_agent=None,
                        source=f'daemon.{message.platform.value}',
                        persist_user_message=True,
                        persist_final_answer=True,
                    )

                # ── 5. 回送响应 ──
                if result.response and result.response.success and result.response.content:
                    await self._daemon_service.send_message(OutgoingMessage(
                        platform=message.platform,
                        chat_id=message.chat_id,
                        content=result.response.content,
                    ))

            finally:
                # ── 6. 清理 ──
                if task_id:
                    registry.finish_task(task_id)
                approval_handler.cleanup()
                self._approval_handlers.pop(message.chat_id, None)
                session_manager.remove(run_id)

        except Exception as e:
            logger.error('消息路由失败: %s', e, exc_info=True)
            try:
                await self._daemon_service.send_message(OutgoingMessage(
                    platform=message.platform,
                    chat_id=message.chat_id,
                    content='❌ 处理消息时出错，请稍后重试。',
                ))
            except Exception:
                pass
