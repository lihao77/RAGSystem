# -*- coding: utf-8 -*-
"""
消息路由器。

负责将社交平台入站消息路由到对应 Agent 执行，
并将执行结果回送到来源平台。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import TYPE_CHECKING, Optional, Tuple

from daemon.models import (
    IncomingMessage,
    OutgoingMessage,
    PlatformType,
)

if TYPE_CHECKING:
    from daemon.service import DaemonService

logger = logging.getLogger(__name__)


class MessageRouter:
    """统一消息路由器。"""

    def __init__(self, daemon_service: DaemonService):
        self._daemon_service = daemon_service

    async def route_incoming(self, message: IncomingMessage) -> None:
        """
        路由入站消息到 Agent 执行。

        流程：
        1. 根据 chat_id 获取/创建守护 session（绑定 team）
        2. 通过 AgentExecutionService 调用目标 team 的入口 Agent
        3. 将 Agent 响应回送到来源平台
        """
        logger.info(
            '收到消息 [%s] chat=%s user=%s: %s',
            message.platform.value,
            message.chat_id,
            message.user_id,
            message.content[:100],
        )

        try:
            from runtime.container import get_current_runtime_container
            container = get_current_runtime_container()
            if not container:
                logger.error('RuntimeContainer 未初始化，无法路由消息')
                return

            runtime_svc = container.get_agent_api_runtime_service()
            exec_svc = runtime_svc.get_agent_execution_service()

            # 确定目标 team 和入口 agent
            team_name, entry_agent = self._resolve_team(message)
            if not team_name:
                logger.error('无法确定目标 team')
                return

            # 获取或创建 session（写入 team，entry_agent 可选）
            session_id = self._daemon_service._get_or_create_session(
                message.chat_id, team_name, entry_agent
            )

            # 执行 Agent（to_thread 避免阻塞事件循环；entry_agent=None 时改走 team 默认入口路由）
            if entry_agent:
                result = await asyncio.to_thread(
                    exec_svc.invoke_agent,
                    mode='root',
                    agent_name=entry_agent,
                    task=message.content,
                    session_id=session_id,
                    source=f'daemon.{message.platform.value}',
                    persist_user_message=True,
                    persist_final_answer=True,
                )
            else:
                result = await asyncio.to_thread(
                    exec_svc.invoke_routed_agent,
                    task=message.content,
                    session_id=session_id,
                    preferred_agent=None,
                    source=f'daemon.{message.platform.value}',
                    persist_user_message=True,
                    persist_final_answer=True,
                )

            # 回送响应
            if result.response and result.response.success and result.response.content:
                await self._daemon_service.send_message(OutgoingMessage(
                    platform=message.platform,
                    chat_id=message.chat_id,
                    content=result.response.content,
                ))

        except Exception as e:
            logger.error('消息路由失败: %s', e, exc_info=True)

    def _resolve_team(self, message: IncomingMessage) -> Tuple[Optional[str], Optional[str]]:
        """根据消息确定目标 team 和入口 agent。返回 (team_name, entry_agent)。"""
        cfg = self._daemon_service.config
        for agent_cfg in cfg.agents:
            if not agent_cfg.enabled:
                continue
            if message.platform in agent_cfg.platforms:
                return agent_cfg.team_name, agent_cfg.entry_agent
        # fallback：取第一个启用的配置
        for agent_cfg in cfg.agents:
            if agent_cfg.enabled:
                return agent_cfg.team_name, agent_cfg.entry_agent
        return None, None
