# -*- coding: utf-8 -*-
"""
守护上下文交互处理器。

订阅 EventBus 的审批和用户输入事件：
- USER_APPROVAL_REQUIRED：工具审批（白名单自动放行 / 交互审批）
- USER_INPUT_REQUIRED：用户输入（发送 prompt 到社交平台，等待回复）
"""

from __future__ import annotations

import asyncio
import logging
import time
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Dict, Optional

if TYPE_CHECKING:
    from daemon.models import DaemonPermissionConfig, PlatformType
    from daemon.service import DaemonService

logger = logging.getLogger(__name__)

# 审批回复关键词映射
_APPROVE_KEYWORDS = frozenset({'同意', '允许', '通过', 'yes', 'y', '是', 'approve', 'ok'})
_DENY_KEYWORDS = frozenset({'拒绝', '不允许', '否决', 'no', 'n', '否', 'deny', 'reject'})


_INPUT_TIMEOUT = 300  # 用户输入超时 5 分钟


@dataclass
class PendingApproval:
    """单个待审批请求的跟踪信息"""
    approval_id: str
    tool_name: str
    risk_level: str
    session_id: str
    chat_id: str
    platform: object  # PlatformType
    created_at: float = field(default_factory=time.time)
    timeout_handle: Optional[asyncio.TimerHandle] = None


@dataclass
class PendingInput:
    """单个待用户输入的跟踪信息"""
    input_id: str
    prompt: str
    input_type: str
    options: list
    session_id: str
    chat_id: str
    platform: object  # PlatformType
    created_at: float = field(default_factory=time.time)
    timeout_handle: Optional[asyncio.TimerHandle] = None


class DaemonApprovalHandler:
    """守护上下文审批处理器。

    - on_approval_required: EventBus 同步回调，在 Agent 工作线程中执行。
      auto-approve 时直接调 resolve_approval → wait_evt.set() → Agent 立即继续。
    - try_resolve_from_message: 路由器入口调用，解析用户审批回复。
    - has_pending: 检查指定 chat_id 是否有待处理的审批。
    """

    def __init__(
        self,
        *,
        daemon_service: DaemonService,
        session_id: str,
        platform: PlatformType,
        chat_id: str,
        permission_config: DaemonPermissionConfig,
        main_loop: asyncio.AbstractEventLoop,
        send_message: Optional[Callable[[str], Awaitable[None]]] = None,
    ):
        self._daemon_service = daemon_service
        self._session_id = session_id
        self._platform = platform
        self._chat_id = chat_id
        self._config = permission_config
        self._main_loop = main_loop
        self._send_message = send_message
        self._pending: Dict[str, PendingApproval] = {}
        self._pending_inputs: Dict[str, PendingInput] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # EventBus 回调（Agent 线程中同步执行）
    # ------------------------------------------------------------------

    def on_approval_required(self, event) -> None:
        """EventBus 同步回调 — 在 Agent 工作线程中执行。"""
        data = event.data or {}
        approval_id = data.get('approval_id')
        tool_name = data.get('tool_name', '')
        risk_level = (data.get('risk_level') or 'high').lower()
        session_id = event.session_id or self._session_id

        if not approval_id:
            logger.warning('DaemonApprovalHandler: 审批事件缺少 approval_id')
            return

        # 策略 1：白名单自动放行
        if tool_name in self._config.tool_allowlist:
            logger.info(
                '守护审批: 工具 %s 在白名单中，自动放行 approval_id=%s',
                tool_name, approval_id,
            )
            self._auto_resolve(session_id, approval_id, True, '守护策略白名单自动放行')
            return

        # 策略 2：交互审批 — 发消息到社交平台 + 启动超时
        logger.info(
            '守护审批: 工具 %s 需要交互审批 approval_id=%s chat_id=%s',
            tool_name, approval_id, self._chat_id,
        )
        pending = PendingApproval(
            approval_id=approval_id,
            tool_name=tool_name,
            risk_level=risk_level,
            session_id=session_id,
            chat_id=self._chat_id,
            platform=self._platform,
        )
        with self._lock:
            self._pending[approval_id] = pending

        # 桥接到 asyncio 事件循环：发送审批消息 + 设超时
        asyncio.run_coroutine_threadsafe(
            self._send_and_schedule_timeout(pending),
            self._main_loop,
        )

    def on_input_required(self, event) -> None:
        """EventBus 同步回调 — Agent 需要用户输入。"""
        data = event.data or {}
        input_id = data.get('input_id')
        prompt = data.get('prompt', '')
        input_type = data.get('input_type', 'text')
        options = data.get('options', [])
        session_id = event.session_id or self._session_id

        if not input_id:
            logger.warning('DaemonInteractionHandler: 输入事件缺少 input_id')
            return

        logger.info(
            '守护输入: 需要用户输入 input_id=%s prompt=%s chat_id=%s',
            input_id, prompt[:60], self._chat_id,
        )
        pending = PendingInput(
            input_id=input_id,
            prompt=prompt,
            input_type=input_type,
            options=options,
            session_id=session_id,
            chat_id=self._chat_id,
            platform=self._platform,
        )
        with self._lock:
            self._pending_inputs[input_id] = pending

        asyncio.run_coroutine_threadsafe(
            self._send_input_prompt(pending),
            self._main_loop,
        )

    # ------------------------------------------------------------------
    # 路由器调用：检查入站消息是否为审批回复
    # ------------------------------------------------------------------

    def has_pending(self, chat_id: str) -> bool:
        with self._lock:
            return any(p.chat_id == chat_id for p in self._pending.values())

    def has_pending_input(self, chat_id: str) -> bool:
        with self._lock:
            return any(p.chat_id == chat_id for p in self._pending_inputs.values())

    def try_resolve_from_message(self, message) -> bool:
        """解析入站消息的审批关键词。返回 True 表示消息已被消费。"""
        content = (message.content or '').strip().lower()
        approved: Optional[bool] = None
        if content in _APPROVE_KEYWORDS:
            approved = True
        elif content in _DENY_KEYWORDS:
            approved = False

        if approved is None:
            return False

        # 查找该 chat_id 最早的待审批
        with self._lock:
            target: Optional[PendingApproval] = None
            for pending in self._pending.values():
                if pending.chat_id == message.chat_id:
                    target = pending
                    break
            if target is None:
                return False
            self._pending.pop(target.approval_id, None)
            if target.timeout_handle:
                target.timeout_handle.cancel()

        # 决议
        msg = '用户审批：同意' if approved else '用户审批：拒绝'
        self._auto_resolve(target.session_id, target.approval_id, approved, msg)

        logger.info(
            '守护审批: 用户回复 approved=%s approval_id=%s tool=%s',
            approved, target.approval_id, target.tool_name,
        )

        # 发送确认反馈
        asyncio.run_coroutine_threadsafe(
            self._send_confirmation(target, approved),
            self._main_loop,
        )
        return True

    def try_resolve_input_from_message(self, message) -> bool:
        """解析入站消息作为用户输入回复。返回 True 表示消息已被消费。"""
        content = (message.content or '').strip()
        if not content:
            return False

        with self._lock:
            target: Optional[PendingInput] = None
            for pending in self._pending_inputs.values():
                if pending.chat_id == message.chat_id:
                    target = pending
                    break
            if target is None:
                return False
            self._pending_inputs.pop(target.input_id, None)
            if target.timeout_handle:
                target.timeout_handle.cancel()

        # 提交用户输入
        self._resolve_input(target.session_id, target.input_id, content)

        logger.info(
            '守护输入: 用户回复 input_id=%s length=%d',
            target.input_id, len(content),
        )

        asyncio.run_coroutine_threadsafe(
            self._send_input_confirmation(target, content),
            self._main_loop,
        )
        return True

    # ------------------------------------------------------------------
    # 清理
    # ------------------------------------------------------------------

    def cleanup(self) -> None:
        with self._lock:
            for pending in self._pending.values():
                if pending.timeout_handle:
                    pending.timeout_handle.cancel()
            self._pending.clear()
            for pending in self._pending_inputs.values():
                if pending.timeout_handle:
                    pending.timeout_handle.cancel()
            self._pending_inputs.clear()

    # ------------------------------------------------------------------
    # 内部方法
    # ------------------------------------------------------------------

    @staticmethod
    def _auto_resolve(session_id: str, approval_id: str, approved: bool, message: str) -> None:
        """立即决议审批（可在任意线程调用）。"""
        from agents.task_registry import get_task_registry
        registry = get_task_registry()
        registry.resolve_approval(session_id, approval_id, approved, message)

    async def _send_text(self, content: str) -> None:
        if self._send_message is not None:
            await self._send_message(content)
            return
        from daemon.models import OutgoingMessage
        await self._daemon_service.send_message(OutgoingMessage(
            platform=self._platform,
            chat_id=self._chat_id,
            content=content,
        ))

    async def _send_and_schedule_timeout(self, pending: PendingApproval) -> None:
        """发送审批消息到社交平台并设置超时。在主事件循环中执行。"""
        fallback_text = '放行' if self._config.approval_fallback == 'allow' else '拒绝'
        msg_content = (
            f'🔧 工具审批请求\n'
            f'工具: {pending.tool_name}\n'
            f'风险级别: {pending.risk_level}\n'
            f'请回复「同意」或「拒绝」来决定是否允许执行。\n'
            f'超时 {self._config.approval_timeout} 秒后将自动{fallback_text}。'
        )
        try:
            await self._send_text(msg_content)
        except Exception as e:
            logger.error('发送审批消息失败: %s', e)

        # 设置超时回调：call_later 中不能直接用 ensure_future，改用 run_coroutine_threadsafe
        def _schedule_timeout(aid: str) -> None:
            asyncio.run_coroutine_threadsafe(self._on_timeout(aid), self._main_loop)

        timeout_handle = self._main_loop.call_later(
            self._config.approval_timeout,
            _schedule_timeout,
            pending.approval_id,
        )
        with self._lock:
            if pending.approval_id in self._pending:
                self._pending[pending.approval_id].timeout_handle = timeout_handle

    async def _on_timeout(self, approval_id: str) -> None:
        with self._lock:
            pending = self._pending.pop(approval_id, None)
        if pending is None:
            return

        approved = self._config.approval_fallback == 'allow'
        fallback_msg = '审批超时，自动放行' if approved else '审批超时，自动拒绝'
        logger.info('守护审批超时: approval_id=%s %s', approval_id, fallback_msg)

        self._auto_resolve(pending.session_id, approval_id, approved, fallback_msg)

        # 通知用户
        try:
            await self._send_text(f'⏰ {fallback_msg}（工具: {pending.tool_name}）')
        except Exception:
            pass

    async def _send_confirmation(self, pending: PendingApproval, approved: bool) -> None:
        icon = '✅' if approved else '❌'
        action = '允许' if approved else '拒绝'
        try:
            await self._send_text(f'{icon} 已{action}执行工具: {pending.tool_name}')
        except Exception:
            pass

    # ------------------------------------------------------------------
    # 用户输入内部方法
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_input(session_id: str, input_id: str, value: str) -> None:
        """提交用户输入（可在任意线程调用）。"""
        from agents.task_registry import get_task_registry
        registry = get_task_registry()
        registry.resolve_input(session_id, input_id, value)

    async def _send_input_prompt(self, pending: PendingInput) -> None:
        """发送输入提示到社交平台并设置超时。"""
        lines = [f'❓ 需要你的输入\n问题: {pending.prompt}']
        if pending.options:
            lines.append('选项: ' + ' / '.join(f'「{o}」' for o in pending.options))
        lines.append(f'请直接回复内容。超时 {_INPUT_TIMEOUT} 秒后将自动提交空值。')
        msg_content = '\n'.join(lines)

        try:
            await self._send_text(msg_content)
        except Exception as e:
            logger.error('发送输入提示失败: %s', e)

        def _schedule_timeout(iid: str) -> None:
            asyncio.run_coroutine_threadsafe(self._on_input_timeout(iid), self._main_loop)

        timeout_handle = self._main_loop.call_later(
            _INPUT_TIMEOUT,
            _schedule_timeout,
            pending.input_id,
        )
        with self._lock:
            if pending.input_id in self._pending_inputs:
                self._pending_inputs[pending.input_id].timeout_handle = timeout_handle

    async def _on_input_timeout(self, input_id: str) -> None:
        with self._lock:
            pending = self._pending_inputs.pop(input_id, None)
        if pending is None:
            return

        logger.info('守护输入超时: input_id=%s，提交空值', input_id)
        self._resolve_input(pending.session_id, input_id, '')

        try:
            await self._send_text(f'⏰ 输入超时，已提交空值（问题: {pending.prompt[:50]}）')
        except Exception:
            pass

    async def _send_input_confirmation(self, pending: PendingInput, value: str) -> None:
        preview = value[:100] + ('...' if len(value) > 100 else '')
        try:
            await self._send_text(f'📝 已接收输入: {preview}')
        except Exception:
            pass
