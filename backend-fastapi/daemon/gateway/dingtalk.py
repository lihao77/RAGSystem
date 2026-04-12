# -*- coding: utf-8 -*-
"""
钉钉适配器。

通过钉钉企业应用 API 发送消息，通过 Webhook 回调接收消息。
"""

from __future__ import annotations

import logging
import time
from typing import Optional

import httpx

from daemon.gateway.base import PlatformAdapter
from daemon.models import (
    AdapterStatus,
    HeartbeatStatus,
    IncomingMessage,
    OutgoingMessage,
    PlatformConnection,
    PlatformType,
)

logger = logging.getLogger(__name__)

_DINGTALK_API_BASE = "https://oapi.dingtalk.com"


class DingTalkAdapter(PlatformAdapter):
    """钉钉平台适配器。"""

    def __init__(self, config: PlatformConnection):
        super().__init__(config)
        self._access_token: Optional[str] = None
        self._token_expires_at: float = 0

    async def connect(self) -> None:
        """获取 access_token 验证连接。"""
        self._status = AdapterStatus.CONNECTING
        try:
            await self._refresh_access_token()
            self._status = AdapterStatus.CONNECTED
            logger.info('钉钉适配器连接成功')
        except Exception as e:
            self._status = AdapterStatus.ERROR
            logger.error('钉钉连接失败: %s', e)
            raise

    async def disconnect(self) -> None:
        self._access_token = None
        self._status = AdapterStatus.DISCONNECTED

    async def _refresh_access_token(self) -> str:
        """刷新 access_token。"""
        if self._access_token and time.time() < self._token_expires_at:
            return self._access_token

        url = f"{_DINGTALK_API_BASE}/gettoken"
        params = {
            "appkey": self._config.app_id or self._config.extra.get("app_key", ""),
            "appsecret": self._config.app_secret or "",
        }
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=params)
            data = resp.json()

        if data.get("errcode", 0) != 0:
            raise RuntimeError(f"获取钉钉 access_token 失败: {data}")

        self._access_token = data["access_token"]
        self._token_expires_at = time.time() + data.get("expires_in", 7200) - 300
        return self._access_token

    async def send_message(self, message: OutgoingMessage) -> bool:
        """发送工作通知消息。"""
        try:
            token = await self._refresh_access_token()
            url = f"{_DINGTALK_API_BASE}/topapi/message/corpconversation/asyncsend_v2?access_token={token}"

            agent_id = int(self._config.extra.get("agent_id", self._config.app_id or 0))
            payload = {
                "agent_id": agent_id,
                "userid_list": message.chat_id,
                "msg": {
                    "msgtype": "text" if message.message_type == "text" else "markdown",
                    "text": {"content": message.content},
                },
            }
            if message.message_type == "markdown":
                payload["msg"] = {
                    "msgtype": "markdown",
                    "markdown": {
                        "title": "Agent 通知",
                        "text": message.content,
                    },
                }

            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload)
                data = resp.json()

            if data.get("errcode", 0) != 0:
                logger.error('钉钉发送失败: %s', data)
                return False
            return True

        except Exception as e:
            logger.error('钉钉发送异常: %s', e)
            self._status = AdapterStatus.ERROR
            return False

    async def health_check(self) -> HeartbeatStatus:
        start = time.time()
        try:
            await self._refresh_access_token()
            latency = (time.time() - start) * 1000
            self._status = AdapterStatus.CONNECTED
            return HeartbeatStatus(
                platform=PlatformType.DINGTALK,
                status=AdapterStatus.CONNECTED,
                last_heartbeat=time.time(),
                latency_ms=latency,
            )
        except Exception as e:
            self._status = AdapterStatus.ERROR
            return HeartbeatStatus(
                platform=PlatformType.DINGTALK,
                status=AdapterStatus.ERROR,
                last_heartbeat=time.time(),
                error=str(e),
            )

    def parse_webhook(self, payload: dict) -> list:
        """解析钉钉回调消息。

        钉钉机器人/事件回调以 JSON 格式推送。
        """
        messages = []
        try:
            msg_type = payload.get("msgtype", "")
            if msg_type == "text":
                content = payload.get("text", {}).get("content", "")
            elif msg_type == "markdown":
                content = payload.get("markdown", {}).get("text", "")
            else:
                content = payload.get("content", {}).get("text", str(payload))

            sender_id = payload.get("senderStaffId") or payload.get("senderId", "")
            conversation_id = payload.get("conversationId") or sender_id
            msg_id = payload.get("msgId", str(hash(content)))

            messages.append(IncomingMessage(
                message_id=msg_id,
                platform=PlatformType.DINGTALK,
                chat_id=conversation_id,
                user_id=sender_id,
                content=content.strip(),
                raw_payload=payload,
                timestamp=payload.get("createAt", time.time()),
            ))

        except Exception as e:
            logger.error('解析钉钉 webhook 失败: %s', e)

        return messages
