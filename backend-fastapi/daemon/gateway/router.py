# -*- coding: utf-8 -*-
"""
消息路由器。

将社交平台入站消息路由到 Agent 执行，
复用 AgentExecutionAdapter（与 Web 前端同一入口），
只做事件流到社交平台的映射。
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Dict

import commands as cmd_mod
from daemon.models import (
    IncomingMessage,
    OutgoingMessage,
)
from daemon.utils import consume_stream

if TYPE_CHECKING:
    from daemon.approval_handler import DaemonApprovalHandler
    from daemon.service import DaemonService

logger = logging.getLogger(__name__)


class MessageRouter:
    """统一消息路由器 — 复用 AgentExecutionAdapter，daemon 只做事件映射。"""

    def __init__(self, daemon_service: DaemonService):
        self._daemon_service = daemon_service
        self._approval_handlers: Dict[str, DaemonApprovalHandler] = {}

    async def route_incoming(self, message: IncomingMessage) -> None:
        """
        路由入站消息到 Agent 执行。

        流程：
        0. 审批回复拦截
        1. 斜杠命令预处理
        2. 解析 session_id + agent 配置
        3. 通过 AgentExecutionAdapter 启动执行（自动管理 EventBus / TaskRegistry / Persistence）
        4. 挂载 DaemonApprovalHandler
        5. 消费事件流，提取 final_answer 回送社交平台
        6. 清理
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

            # ── 1. 斜杠命令预处理 ──
            task = message.content.strip()
            display_task = None

            # 解析 session（斜杠命令也需要 session_id）
            session_id, agent_config = await self._daemon_service.resolve_session_id_for_message(message)

            if task.startswith('/'):
                parsed = cmd_mod.parse_slash_command(task)
                if parsed is not None:
                    if parsed.defn is None:
                        await self._daemon_service.send_message(OutgoingMessage(
                            platform=message.platform,
                            chat_id=message.chat_id,
                            content=f'未知命令: {parsed.cmd_name}\n输入 /help 查看可用命令',
                        ))
                        return
                    if parsed.defn.mode == 'system':
                        try:
                            result = await parsed.defn.handler(session_id, parsed.args)
                        except Exception as e:
                            result = {'content': f'命令执行失败: {e}', 'success': False}
                        await self._daemon_service.send_message(OutgoingMessage(
                            platform=message.platform,
                            chat_id=message.chat_id,
                            content=result.get('content', '命令已执行'),
                        ))
                        return
                    # prompt 命令：展开模板
                    if not parsed.args.strip():
                        await self._daemon_service.send_message(OutgoingMessage(
                            platform=message.platform,
                            chat_id=message.chat_id,
                            content=f'用法: {parsed.cmd_name} <内容>\n{parsed.defn.description}',
                        ))
                        return
                    display_task = task
                    task = parsed.defn.template.replace('{args}', parsed.args)

            if not task:
                return

            # ── 2. 获取运行时依赖 ──
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            if not container:
                logger.error('RuntimeContainer 未初始化，无法路由消息')
                return

            runtime_svc = container.get_agent_api_runtime_service()

            # ── 3. 通过 AgentExecutionAdapter 启动执行 ──
            from execution.adapters.agent_execution import AgentExecutionAdapter

            adapter = AgentExecutionAdapter(
                execution_service=container.get_execution_service(),
                agent_execution_service=runtime_svc.get_agent_execution_service(),
            )
            started = adapter.start_stream_execution(
                task=task,
                session_id=session_id,
                user_id=message.user_id,
                llm_override=None,
                llm_tier=None,
                request_id=None,
                conversation_store=runtime_svc.get_conversation_store(),
                orchestrator=runtime_svc.create_execution_orchestrator(session_id=session_id),
                history_loader=None,
                display_task=display_task,
                source=f'daemon.{message.platform.value}',
            )

            if not started.started or started.sse_adapter is None:
                error_msg = started.error_message or '启动执行失败'
                logger.warning('Daemon 执行启动失败: %s', error_msg)
                await self._daemon_service.send_message(OutgoingMessage(
                    platform=message.platform,
                    chat_id=message.chat_id,
                    content=f'⏳ {error_msg}',
                ))
                return

            # ── 4. 挂载审批处理器 ──
            from agents.events.bus import EventType
            from daemon.approval_handler import DaemonApprovalHandler
            from daemon.models import DaemonPermissionConfig

            session_manager = container.get_session_manager()
            event_bus = session_manager.get_or_create(started.run_id, session_id=session_id)

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

            # ── 5. 消费事件流 + 回送 ──
            try:
                final_answer = await asyncio.to_thread(consume_stream, started.sse_adapter)
                if final_answer:
                    await self._daemon_service.send_message(OutgoingMessage(
                        platform=message.platform,
                        chat_id=message.chat_id,
                        content=final_answer,
                    ))
            finally:
                # ── 6. 清理 ──
                try:
                    started.sse_adapter.stop()
                except Exception:
                    pass
                approval_handler.cleanup()
                self._approval_handlers.pop(message.chat_id, None)
                try:
                    from agents.context.session_cache import flush_session
                    flush_session(session_id)
                except Exception:
                    pass
                try:
                    from agents.events.session_manager import cleanup_run
                    cleanup_run(started.run_id)
                except Exception:
                    pass

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
