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
import time
from typing import TYPE_CHECKING, Dict

import commands as cmd_mod
from daemon.models import (
    IncomingMessage,
    OutgoingMessage,
)
from daemon.utils import wait_for_run_end

if TYPE_CHECKING:
    from daemon.approval_handler import DaemonApprovalHandler
    from daemon.service import DaemonService

logger = logging.getLogger(__name__)


class MessageRouter:
    """统一消息路由器 — 复用 AgentExecutionAdapter，daemon 只做事件映射。"""

    def __init__(self, daemon_service: DaemonService):
        self._daemon_service = daemon_service
        self._approval_handlers: Dict[str, DaemonApprovalHandler] = {}
        self._chat_locks: Dict[str, asyncio.Lock] = {}

    async def route_incoming(self, message: IncomingMessage) -> None:
        """
        路由入站消息到 Agent 执行。

        流程：
        0. 审批回复拦截（必须在 chat_lock 之前，否则死锁）
        1. Per-chat 锁序列化启动阶段
        2. 等待 run 结束 + 清理（在 lock 外执行，避免长时间持锁）
        """
        # ── 0. 交互拦截（必须在 chat_lock 之前）──
        handler = self._approval_handlers.get(message.chat_id)
        if handler:
            if handler.has_pending(message.chat_id):
                resolved = handler.try_resolve_from_message(message)
                if resolved:
                    logger.info('消息被当作审批回复处理: chat_id=%s', message.chat_id)
                    return
            if handler.has_pending_input(message.chat_id):
                resolved = handler.try_resolve_input_from_message(message)
                if resolved:
                    logger.info('消息被当作用户输入处理: chat_id=%s', message.chat_id)
                    return

        # Per-chat 锁：仅保护启动阶段（步骤 1-4），不持有锁等待 run 结束
        chat_lock = self._chat_locks.setdefault(message.chat_id, asyncio.Lock())
        async with chat_lock:
            run_ctx = await self._start_agent_run(message)
        # 清理无活跃处理的 lock
        if not chat_lock.locked():
            self._chat_locks.pop(message.chat_id, None)

        # 等待 + 清理在 lock 外执行，允许同一 chat 的审批消息及时通过
        if run_ctx is not None:
            await self._wait_and_cleanup(message, run_ctx)

    async def _start_agent_run(self, message: IncomingMessage):
        """启动阶段（在 chat_lock 内执行）。返回 run 上下文 dict 或 None。"""
        logger.info(
            '收到消息 [%s] chat=%s user=%s: %s',
            message.platform.value,
            message.chat_id,
            message.user_id,
            message.content[:100],
        )

        try:
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
                        return None
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
                        return None
                    # prompt 命令：展开模板
                    if not parsed.args.strip():
                        await self._daemon_service.send_message(OutgoingMessage(
                            platform=message.platform,
                            chat_id=message.chat_id,
                            content=f'用法: {parsed.cmd_name} <内容>\n{parsed.defn.description}',
                        ))
                        return None
                    display_task = task
                    task = parsed.defn.template.replace('{args}', parsed.args)

            if not task:
                return None

            # ── 2. 获取运行时依赖 ──
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            if not container:
                logger.error('RuntimeContainer 未初始化，无法路由消息')
                return None

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

            if not started.started:
                error_msg = started.error_message or '启动执行失败'
                logger.warning('Daemon 执行启动失败: %s', error_msg)
                await self._daemon_service.send_message(OutgoingMessage(
                    platform=message.platform,
                    chat_id=message.chat_id,
                    content=f'⏳ {error_msg}',
                ))
                return None

            # ── 4. 挂载审批处理器 + 事件桥接 ──
            from agents.events.bus import EventType
            from daemon.approval_handler import DaemonApprovalHandler

            session_manager = container.get_session_manager()
            event_bus = session_manager.get_or_create(started.run_id, session_id=session_id)

            _main_loop = asyncio.get_running_loop()
            _platform = message.platform
            _chat_id = message.chat_id
            _send_lock = asyncio.Lock()

            async def _ordered_send(content: str):
                async with _send_lock:
                    await self._daemon_service.send_message(OutgoingMessage(
                        platform=_platform,
                        chat_id=_chat_id,
                        content=content,
                    ))

            def _send_to_platform(content: str):
                asyncio.run_coroutine_threadsafe(_ordered_send(content), _main_loop)

            permission_config = getattr(agent_config, 'permissions', None)
            if permission_config is None:
                permission_config = self._daemon_service._build_default_daemon_permission_policy()

            approval_handler = DaemonApprovalHandler(
                daemon_service=self._daemon_service,
                session_id=session_id,
                platform=message.platform,
                chat_id=message.chat_id,
                permission_config=permission_config,
                main_loop=asyncio.get_running_loop(),
                send_message=_ordered_send,
            )

            daemon_event_types = [
                EventType.USER_APPROVAL_REQUIRED,
                EventType.USER_INPUT_REQUIRED,
                EventType.AGENT_ERROR,
                EventType.CALL_TOOL_START,
                EventType.CALL_TOOL_END,
                EventType.AGENT_RETRY_SCHEDULED,
                EventType.INTENT_COMPLETE,
            ]

            # 工具事件节流状态：避免高频工具调用刷屏社交平台
            _last_tool_push_time = [0.0]  # mutable in closure
            _TOOL_PUSH_INTERVAL = 5.0  # 工具事件最小推送间隔（秒）
            _TOOL_SLOW_THRESHOLD = 3.0  # 工具耗时超过此值才推送完成消息

            def _handle_daemon_event(event):
                if event.type == EventType.USER_APPROVAL_REQUIRED:
                    approval_handler.on_approval_required(event)
                    return
                if event.type == EventType.USER_INPUT_REQUIRED:
                    approval_handler.on_input_required(event)
                    return
                if event.type == EventType.AGENT_ERROR:
                    error_data = event.data or {}
                    error_msg = error_data.get('error', '未知错误')
                    error_type = error_data.get('error_type', '')
                    label = f' ({error_type})' if error_type else ''
                    _send_to_platform(f'❌ 执行出错{label}: {error_msg}')
                    return
                if event.type == EventType.CALL_TOOL_START:
                    now = time.monotonic()
                    if now - _last_tool_push_time[0] < _TOOL_PUSH_INTERVAL:
                        return  # 节流：间隔内不推送
                    data = event.data or {}
                    tool_name = data.get('tool_name', '?')
                    _send_to_platform(f'🔧 正在执行: {tool_name}')
                    _last_tool_push_time[0] = now
                    return
                if event.type == EventType.CALL_TOOL_END:
                    data = event.data or {}
                    elapsed = data.get('execution_time')
                    success = data.get('success', True)
                    # 仅推送失败或耗时较长的工具调用
                    if success and (not elapsed or elapsed < _TOOL_SLOW_THRESHOLD):
                        return
                    tool_name = data.get('tool_name', '?')
                    time_label = f' ({elapsed:.1f}s)' if elapsed else ''
                    icon = '✅' if success else '❌'
                    status = '完成' if success else '失败'
                    _send_to_platform(f'{icon} {tool_name} {status}{time_label}')
                    return
                if event.type == EventType.AGENT_RETRY_SCHEDULED:
                    data = event.data or {}
                    attempt = data.get('failed_attempt', '?')
                    max_a = data.get('max_attempts', '?')
                    wait = data.get('wait_seconds', 0)
                    _send_to_platform(f'⚠️ 模型调用失败，第 {attempt}/{max_a} 次重试（等待 {wait:.1f}s）...')
                    return
                if event.type == EventType.INTENT_COMPLETE:
                    data = event.data or {}
                    content = data.get('content', '')
                    if content:
                        _send_to_platform(f'💭 {content[:500]}')

            _subscription_id = event_bus.subscribe(
                event_types=daemon_event_types,
                handler=_handle_daemon_event,
            )
            self._approval_handlers[message.chat_id] = approval_handler

            return {
                'session_id': session_id,
                'run_id': started.run_id,
                'event_bus': event_bus,
                'subscription_id': _subscription_id,
                'approval_handler': approval_handler,
                'ordered_send': _ordered_send,
            }

        except Exception as e:
            logger.error('消息路由启动失败: %s', e, exc_info=True)
            try:
                await self._daemon_service.send_message(OutgoingMessage(
                    platform=message.platform,
                    chat_id=message.chat_id,
                    content='❌ 处理消息时出错，请稍后重试。',
                ))
            except Exception:
                pass
            return None

    async def _wait_and_cleanup(self, message: IncomingMessage, ctx: dict) -> None:
        """等待 run 结束并清理资源（在 chat_lock 外执行）。"""
        session_id = ctx['session_id']
        run_id = ctx['run_id']
        event_bus = ctx['event_bus']
        subscription_id = ctx['subscription_id']
        approval_handler = ctx['approval_handler']
        ordered_send = ctx['ordered_send']

        try:
            final_answer = await asyncio.to_thread(wait_for_run_end, event_bus, session_id)
            if final_answer:
                await ordered_send(final_answer)
        except Exception as e:
            logger.error('等待 run 结束失败: %s', e, exc_info=True)
        finally:
            try:
                event_bus.unsubscribe(subscription_id)
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
                cleanup_run(run_id)
            except Exception:
                pass
