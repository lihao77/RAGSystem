# -*- coding: utf-8 -*-
"""
企业微信适配器。

通过企业微信应用消息 API 发送消息，通过 Webhook 回调接收消息。
"""

from __future__ import annotations

import hashlib
import logging
import time
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional
from urllib.parse import quote

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

# 企业微信 API 基地址
_WECHAT_API_BASE = "https://qyapi.weixin.qq.com/cgi-bin"


class WeChatAdapter(PlatformAdapter):
    """企业微信平台适配器。"""

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
            logger.info('企业微信适配器连接成功')
        except Exception as e:
            self._status = AdapterStatus.ERROR
            logger.error('企业微信连接失败: %s', e)
            raise

    async def disconnect(self) -> None:
        """断开连接。"""
        self._access_token = None
        self._status = AdapterStatus.DISCONNECTED

    async def _refresh_access_token(self) -> str:
        """刷新 access_token。"""
        if self._access_token and time.time() < self._token_expires_at:
            return self._access_token

        url = f"{_WECHAT_API_BASE}/gettoken"
        params = {
            "corpid": self._config.extra.get("corp_id", ""),
            "corpsecret": self._config.app_secret or "",
        }
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=params)
            data = resp.json()

        if data.get("errcode", 0) != 0:
            raise RuntimeError(f"获取 access_token 失败: {data}")

        self._access_token = data["access_token"]
        self._token_expires_at = time.time() + data.get("expires_in", 7200) - 300
        return self._access_token

    async def send_message(self, message: OutgoingMessage) -> bool:
        """发送应用消息。"""
        try:
            token = await self._refresh_access_token()
            url = f"{_WECHAT_API_BASE}/message/send?access_token={token}"

            payload = {
                "touser": message.chat_id,
                "msgtype": "text" if message.message_type == "text" else "markdown",
                "agentid": int(self._config.app_id or 0),
            }
            if message.message_type == "markdown":
                payload["markdown"] = {"content": message.content}
            else:
                payload["text"] = {"content": message.content}

            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload)
                data = resp.json()

            if data.get("errcode", 0) != 0:
                logger.error('企业微信发送失败: %s', data)
                return False
            return True

        except Exception as e:
            logger.error('企业微信发送异常: %s', e)
            self._status = AdapterStatus.ERROR
            return False

    async def health_check(self) -> HeartbeatStatus:
        """通过刷新 token 验证连接健康。"""
        start = time.time()
        try:
            await self._refresh_access_token()
            latency = (time.time() - start) * 1000
            self._status = AdapterStatus.CONNECTED
            return HeartbeatStatus(
                platform=PlatformType.WECHAT,
                status=AdapterStatus.CONNECTED,
                last_heartbeat=time.time(),
                latency_ms=latency,
            )
        except Exception as e:
            self._status = AdapterStatus.ERROR
            return HeartbeatStatus(
                platform=PlatformType.WECHAT,
                status=AdapterStatus.ERROR,
                last_heartbeat=time.time(),
                error=str(e),
            )

    def verify_webhook_signature(self, headers: dict, raw_body: bytes) -> bool:
        """验证企业微信回调签名（msg_signature = sha1(sort(token, timestamp, nonce, encrypt))）。"""
        token = self._config.token
        if not token:
            return True

        timestamp = headers.get('timestamp', '')
        nonce = headers.get('nonce', '')

        try:
            body = raw_body.decode('utf-8', errors='replace')
            root = ET.fromstring(body)
            encrypt = root.findtext('Encrypt', '')
        except Exception:
            encrypt = ''

        if not encrypt:
            return True

        items = sorted([token, timestamp, nonce, encrypt])
        signature = hashlib.sha1(''.join(items).encode()).hexdigest()
        return signature == headers.get('msg_signature', '')

    def parse_webhook(self, payload: dict) -> list:
        """解析企业微信回调消息。

        企业微信通过 XML 格式推送消息。
        payload 应包含 'body'（原始 XML 字符串或已解析的 dict）。
        """
        messages = []
        try:
            body = payload.get('body', payload)
            if isinstance(body, str):
                root = ET.fromstring(body)
                content = root.findtext('Content', '')
                from_user = root.findtext('FromUserName', '')
                msg_id = root.findtext('MsgId', '')
                create_time = float(root.findtext('CreateTime', '0'))
            elif isinstance(body, dict):
                content = body.get('Content', {}).get('text', body.get('Content', ''))
                from_user = body.get('FromUserName', '')
                msg_id = body.get('MsgId', str(hash(body.get('Content', ''))))
                create_time = float(body.get('CreateTime', 0))
            else:
                return messages

            messages.append(IncomingMessage(
                message_id=msg_id or str(hash(content)),
                platform=PlatformType.WECHAT,
                chat_id=from_user,
                user_id=from_user,
                content=content,
                raw_payload=payload,
                timestamp=create_time or time.time(),
            ))

        except Exception as e:
            logger.error('解析企业微信 webhook 失败: %s', e)

        return messages
