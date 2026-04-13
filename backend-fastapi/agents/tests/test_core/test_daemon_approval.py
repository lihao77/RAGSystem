# -*- coding: utf-8 -*-
"""DaemonApprovalHandler 单元测试。"""
import asyncio
import threading
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from daemon.approval_handler import DaemonApprovalHandler, PendingApproval
from daemon.models import DaemonPermissionConfig, PlatformType


class _FakeDaemonService:
    def __init__(self):
        self.sent_messages = []

    async def send_message(self, msg):
        self.sent_messages.append(msg)
        return True


def _make_event(approval_id='ap_1', tool_name='write_file', risk_level='high', session_id='s1'):
    return SimpleNamespace(
        data={
            'approval_id': approval_id,
            'tool_name': tool_name,
            'risk_level': risk_level,
        },
        session_id=session_id,
    )


def _make_message(content='同意', chat_id='chat_1'):
    return SimpleNamespace(content=content, chat_id=chat_id)


@pytest.fixture()
def loop():
    lp = asyncio.new_event_loop()
    t = threading.Thread(target=lp.run_forever, daemon=True)
    t.start()
    yield lp
    lp.call_soon_threadsafe(lp.stop)
    t.join(timeout=2)
    lp.close()


@pytest.fixture()
def handler(loop):
    svc = _FakeDaemonService()
    return DaemonApprovalHandler(
        daemon_service=svc,
        session_id='s1',
        platform=PlatformType.FEISHU,
        chat_id='chat_1',
        permission_config=DaemonPermissionConfig(
            tool_allowlist=['read_file', 'glob'],
            auto_approve_risk='low',
            approval_timeout=10,
            approval_fallback='deny',
        ),
        main_loop=loop,
    )


# ── 白名单自动放行 ──

def test_whitelist_auto_approve(handler):
    """白名单中的工具应立即 auto-approve。"""
    event = _make_event(tool_name='read_file', risk_level='low')

    resolved = {}

    with patch('agents.task_registry.get_task_registry') as mock_reg:
        registry = MagicMock()
        mock_reg.return_value = registry
        handler.on_approval_required(event)
        registry.resolve_approval.assert_called_once_with('s1', 'ap_1', True, '守护策略白名单自动放行')


# ── 风险级别自动放行 ──

def test_risk_level_auto_approve(handler):
    """风险级别 ≤ auto_approve_risk 应自动放行。"""
    event = _make_event(tool_name='preview_data_structure', risk_level='low')

    with patch('agents.task_registry.get_task_registry') as mock_reg:
        registry = MagicMock()
        mock_reg.return_value = registry
        handler.on_approval_required(event)
        registry.resolve_approval.assert_called_once()
        args = registry.resolve_approval.call_args
        assert args[0][2] is True  # approved


# ── 高风险触发交互审批 ──

def test_high_risk_triggers_interactive(handler, loop):
    """高风险工具应记录 pending 并发送审批消息。"""
    event = _make_event(tool_name='execute_bash', risk_level='high')

    handler.on_approval_required(event)

    assert handler.has_pending('chat_1')

    # 等待异步消息发送完成（loop 在后台线程运行）
    time.sleep(0.3)
    assert len(handler._daemon_service.sent_messages) == 1
    assert '审批请求' in handler._daemon_service.sent_messages[0].content


# ── 用户回复同意 ──

def test_user_reply_approve(handler, loop):
    """用户回复"同意"应解决审批。"""
    event = _make_event(tool_name='execute_bash', risk_level='high')

    with patch('agents.task_registry.get_task_registry') as mock_reg:
        registry = MagicMock()
        mock_reg.return_value = registry
        handler.on_approval_required(event)

        msg = _make_message(content='同意')
        resolved = handler.try_resolve_from_message(msg)

        assert resolved is True
        assert not handler.has_pending('chat_1')
        registry.resolve_approval.assert_called_once_with('s1', 'ap_1', True, '用户审批：同意')


# ── 用户回复拒绝 ──

def test_user_reply_deny(handler, loop):
    """用户回复"拒绝"应拒绝审批。"""
    event = _make_event(tool_name='execute_bash', risk_level='high')

    with patch('agents.task_registry.get_task_registry') as mock_reg:
        registry = MagicMock()
        mock_reg.return_value = registry
        handler.on_approval_required(event)

        msg = _make_message(content='拒绝')
        resolved = handler.try_resolve_from_message(msg)

        assert resolved is True
        registry.resolve_approval.assert_called_once_with('s1', 'ap_1', False, '用户审批：拒绝')


# ── 非关键词不被消费 ──

def test_unrelated_message_not_consumed(handler, loop):
    """非审批关键词的消息不应被当作审批回复。"""
    event = _make_event(tool_name='execute_bash', risk_level='high')

    handler.on_approval_required(event)

    msg = _make_message(content='你好，这是一条普通消息')
    resolved = handler.try_resolve_from_message(msg)
    assert resolved is False
    assert handler.has_pending('chat_1')


# ── 无 pending 时不拦截消息 ──

def test_no_pending_returns_false(handler):
    """没有待审批时 try_resolve 返回 False。"""
    msg = _make_message(content='同意')
    assert handler.try_resolve_from_message(msg) is False


# ── cleanup 取消超时 ──

def test_cleanup_cancels_timeouts(handler, loop):
    """cleanup 应取消所有待审批的超时计时器。"""
    event = _make_event(tool_name='execute_bash', risk_level='high')

    handler.on_approval_required(event)

    assert handler.has_pending('chat_1')
    handler.cleanup()
    assert not handler.has_pending('chat_1')


# ── auto_approve_risk=medium 放行 medium 风险 ──

def test_medium_risk_auto_approve_when_configured():
    """配置 auto_approve_risk=medium 时，medium 风险工具应自动放行。"""
    loop = asyncio.new_event_loop()
    try:
        h = DaemonApprovalHandler(
            daemon_service=_FakeDaemonService(),
            session_id='s1',
            platform=PlatformType.FEISHU,
            chat_id='chat_1',
            permission_config=DaemonPermissionConfig(
                auto_approve_risk='medium',
            ),
            main_loop=loop,
        )
        event = _make_event(tool_name='execute_code', risk_level='medium')

        with patch('agents.task_registry.get_task_registry') as mock_reg:
            registry = MagicMock()
            mock_reg.return_value = registry
            h.on_approval_required(event)
            args = registry.resolve_approval.call_args
            assert args[0][2] is True  # approved
    finally:
        loop.close()
