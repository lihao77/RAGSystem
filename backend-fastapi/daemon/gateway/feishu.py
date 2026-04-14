# -*- coding: utf-8 -*-
"""
飞书适配器。

支持两种入站模式：
1. webhook：通过事件订阅回调接收消息
2. long_connection：通过飞书官方 Python SDK 长连接接收消息

出站消息统一走飞书开放平台消息 API。
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import threading
import time
from typing import Awaitable, Callable, Optional

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

_FEISHU_API_BASE = "https://open.feishu.cn/open-apis"
_LONG_CONNECTION_READY_TIMEOUT = 20
_LONG_CONNECTION_STOP_TIMEOUT = 10


class FeishuAdapter(PlatformAdapter):
    """飞书平台适配器。"""

    def __init__(
        self,
        config: PlatformConnection,
        incoming_handler: Optional[Callable[[IncomingMessage], Awaitable[None]]] = None,
    ):
        super().__init__(config)
        self._tenant_access_token: Optional[str] = None
        self._token_expires_at: float = 0
        self._incoming_handler = incoming_handler
        self._main_loop: Optional[asyncio.AbstractEventLoop] = None
        self._long_conn_client = None
        self._long_conn_loop: Optional[asyncio.AbstractEventLoop] = None
        self._long_conn_stop_event = None
        self._long_conn_thread: Optional[threading.Thread] = None
        self._long_conn_error: Optional[str] = None

    def _receive_mode(self) -> str:
        return str((self._config.extra or {}).get('receive_mode') or 'webhook').strip().lower()

    def _use_long_connection(self) -> bool:
        return self._receive_mode() == 'long_connection'

    def _is_long_connection_active(self) -> bool:
        thread = self._long_conn_thread
        client = self._long_conn_client
        conn = getattr(client, '_conn', None) if client else None
        return bool(thread and thread.is_alive() and client and conn is not None)

    async def connect(self) -> None:
        """验证凭证，并按配置建立 webhook / 长连接接收能力。"""
        self._status = AdapterStatus.CONNECTING
        try:
            await self._refresh_access_token()
            self._main_loop = asyncio.get_running_loop()
            if self._use_long_connection():
                await self._start_long_connection()
                logger.info('飞书适配器连接成功（长连接）')
            else:
                logger.info('飞书适配器连接成功（webhook）')
            self._status = AdapterStatus.CONNECTED
        except Exception as e:
            self._status = AdapterStatus.ERROR
            logger.error('飞书连接失败: %s', e)
            raise

    async def disconnect(self) -> None:
        await self._stop_long_connection()
        self._tenant_access_token = None
        self._token_expires_at = 0
        self._status = AdapterStatus.DISCONNECTED

    async def _refresh_access_token(self) -> str:
        """刷新 tenant_access_token。"""
        if self._tenant_access_token and time.time() < self._token_expires_at:
            return self._tenant_access_token

        url = f"{_FEISHU_API_BASE}/auth/v3/tenant_access_token/internal"
        payload = {
            "app_id": self._config.app_id or "",
            "app_secret": self._config.app_secret or "",
        }
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json=payload)
            data = resp.json()

        if data.get("code", 0) != 0:
            raise RuntimeError(f"获取飞书 tenant_access_token 失败: {data}")

        self._tenant_access_token = data["tenant_access_token"]
        self._token_expires_at = time.time() + data.get("expire", 7200) - 300
        return self._tenant_access_token

    async def _start_long_connection(self) -> None:
        if self._is_long_connection_active():
            return

        if self._long_conn_thread and self._long_conn_thread.is_alive():
            await self._stop_long_connection()

        ready_event = threading.Event()
        state: dict[str, str] = {}
        self._long_conn_error = None

        def runner() -> None:
            loop = asyncio.new_event_loop()
            self._long_conn_loop = loop
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(self._run_long_connection_client(ready_event, state))
            except Exception as e:
                self._long_conn_error = str(e)
                self._status = AdapterStatus.ERROR
                state['error'] = str(e)
                logger.error('飞书长连接异常: %s', e, exc_info=True)
                ready_event.set()
            finally:
                pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
                for task in pending:
                    task.cancel()
                if pending:
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                # 回收所有已完成但异常未被 retrieve 的 task，避免 asyncio 输出噪声警告
                for task in asyncio.all_tasks(loop):
                    if task.done() and not task.cancelled():
                        try:
                            task.exception()
                        except Exception:
                            pass
                loop.close()
                self._long_conn_loop = None
                self._long_conn_stop_event = None
                self._long_conn_client = None

        self._long_conn_thread = threading.Thread(
            target=runner,
            name='feishu-long-connection',
            daemon=True,
        )
        self._long_conn_thread.start()

        started = await asyncio.to_thread(ready_event.wait, _LONG_CONNECTION_READY_TIMEOUT)
        if not started:
            raise RuntimeError('飞书长连接启动超时，请检查网络与应用配置')
        if state.get('error'):
            raise RuntimeError(state['error'])
        if not self._is_long_connection_active():
            raise RuntimeError(self._long_conn_error or '飞书长连接未成功建立')

    async def _stop_long_connection(self) -> None:
        thread = self._long_conn_thread
        stop_future = self._long_conn_stop_event
        loop = self._long_conn_loop

        if stop_future is not None and loop is not None and loop.is_running():
            if not stop_future.done():
                loop.call_soon_threadsafe(stop_future.set_result, None)

        if thread and thread.is_alive():
            await asyncio.to_thread(thread.join, _LONG_CONNECTION_STOP_TIMEOUT)
            if thread.is_alive():
                logger.warning('飞书长连接线程未在预期时间内退出')

        self._long_conn_thread = None

    async def _run_long_connection_client(self, ready_event: threading.Event, state: dict) -> None:
        try:
            import lark_oapi.ws.client as ws_client_module
            from lark_oapi.core.enum import LogLevel
            from lark_oapi.event.dispatcher_handler import EventDispatcherHandler
            from lark_oapi.ws.client import Client
        except ImportError as e:
            raise RuntimeError(
                '飞书长连接模式需要安装 lark-oapi 依赖，请执行 pip install -r requirements.txt'
            ) from e

        sdk_loop = asyncio.get_running_loop()
        previous_loop = ws_client_module.loop
        ws_client_module.loop = sdk_loop

        # 安装异常处理器：静默 ConnectionClosedOK（code=1000）噪声
        # asyncio 在 task 析构时若异常未被 retrieve 会调用此处理器
        _orig_exception_handler = sdk_loop.get_exception_handler()

        def _exception_handler(loop, context):
            exc = context.get('exception')
            if exc is not None and type(exc).__name__ == 'ConnectionClosedOK':
                return  # 正常关闭，忽略
            if _orig_exception_handler:
                _orig_exception_handler(loop, context)
            else:
                loop.default_exception_handler(context)

        sdk_loop.set_exception_handler(_exception_handler)

        # 用 loop.create_future() 替代 asyncio.Event()，显式绑定到当前 loop，
        # 避免 lark-oapi SDK 内部操作导致 Event 懒绑定到错误的 loop
        stop_future = sdk_loop.create_future()
        self._long_conn_stop_event = stop_future

        try:
            handler = (
                EventDispatcherHandler
                .builder(self._config.encoding_aes_key or '', self._config.token or '')
                .register_p2_im_message_receive_v1(self._handle_long_connection_message)
                .build()
            )
            client = Client(
                app_id=self._config.app_id or '',
                app_secret=self._config.app_secret or '',
                log_level=LogLevel.INFO,
                event_handler=handler,
                auto_reconnect=False,
            )
            self._long_conn_client = client
            await client._connect()
            ping_task = asyncio.create_task(client._ping_loop(), name='feishu-long-connection-ping')
            ready_event.set()
            await stop_future
            # stop_future 触发时，SDK 内部的 _receive_message_loop task 可能已结束且异常未被 retrieve
            # 必须在 _disconnect() 之前回收，否则 asyncio 会打印 "Task exception was never retrieved"
            for t in list(asyncio.all_tasks(sdk_loop)):
                if t is not asyncio.current_task() and t.done() and not t.cancelled():
                    try:
                        t.exception()
                    except Exception:
                        pass
            # 关闭前静音 lark SDK logger，避免正常断开被当作 ERROR 输出
            lark_logger = logging.getLogger('Lark')
            prev_lark_level = lark_logger.level
            lark_logger.setLevel(logging.CRITICAL)
            try:
                client._auto_reconnect = False
                await client._disconnect()
            finally:
                lark_logger.setLevel(prev_lark_level)
            ping_task.cancel()
            await asyncio.gather(ping_task, return_exceptions=True)
        except Exception as e:
            if not stop_future.done():
                stop_future.set_result(None)
            self._long_conn_error = str(e)
            state['error'] = str(e)
            ready_event.set()
            raise
        finally:
            sdk_loop.set_exception_handler(_orig_exception_handler)
            ws_client_module.loop = previous_loop

    def _handle_long_connection_message(self, data) -> None:
        try:
            message = self._build_incoming_message_from_long_connection_event(data)
            if not message:
                return None
            logger.info(
                '收到飞书长连接消息: chat_id=%s user_id=%s message_id=%s',
                message.chat_id,
                message.user_id,
                message.message_id,
            )
            self._dispatch_incoming_message(message)
        except Exception as e:
            logger.error('处理飞书长连接消息失败: %s', e, exc_info=True)
        return None

    def _dispatch_incoming_message(self, message: IncomingMessage) -> None:
        if not self._incoming_handler or not self._main_loop:
            logger.warning('飞书长连接收到消息，但未配置入站处理器')
            return
        future = asyncio.run_coroutine_threadsafe(
            self._incoming_handler(message),
            self._main_loop,
        )
        future.add_done_callback(self._on_dispatch_done)

    def _on_dispatch_done(self, future) -> None:
        try:
            future.result()
        except Exception as e:
            logger.error('飞书长连接消息分发失败: %s', e, exc_info=True)

    def _build_incoming_message_from_long_connection_event(self, data) -> Optional[IncomingMessage]:
        event = getattr(data, 'event', None)
        if not event:
            return None

        message = getattr(event, 'message', None)
        sender = getattr(event, 'sender', None)
        sender_id = getattr(sender, 'sender_id', None)
        if not message:
            return None

        content = self._extract_content_text(getattr(message, 'content', '') or '')
        user_id = (
            getattr(sender_id, 'user_id', None)
            or getattr(sender_id, 'open_id', None)
            or getattr(sender_id, 'union_id', None)
            or ''
        )
        chat_id = getattr(message, 'chat_id', None) or user_id
        message_id = getattr(message, 'message_id', None) or f"feishu_{int(time.time() * 1000)}"
        timestamp = self._normalize_timestamp(getattr(message, 'create_time', None))

        return IncomingMessage(
            message_id=message_id,
            platform=PlatformType.FEISHU,
            chat_id=chat_id,
            user_id=user_id,
            content=content.strip(),
            raw_payload={
                'chat_id': chat_id,
                'user_id': user_id,
                'message_id': message_id,
                'message_type': getattr(message, 'message_type', None),
            },
            timestamp=timestamp,
        )

    def _extract_content_text(self, content: str) -> str:
        if not content:
            return ''
        try:
            content_obj = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return str(content)

        if isinstance(content_obj, dict):
            return str(
                content_obj.get('text')
                or content_obj.get('title')
                or content_obj.get('content')
                or content
            )
        return str(content_obj)

    def _normalize_timestamp(self, raw_timestamp) -> float:
        if raw_timestamp in (None, ''):
            return time.time()
        try:
            timestamp = float(raw_timestamp)
        except (TypeError, ValueError):
            return time.time()
        if timestamp > 10**12:
            timestamp /= 1000.0
        return timestamp

    def verify_webhook_signature(self, headers: dict, raw_body: bytes) -> bool:
        """验证飞书事件订阅签名（X-Lark-Signature = HMAC-SHA256(app_secret, timestamp + body)）。"""
        secret = self._config.app_secret
        if not secret:
            return True

        timestamp = headers.get('x-lark-request-timestamp', '')
        signature = headers.get('x-lark-signature', '')
        if not timestamp or not signature:
            return False

        string_to_sign = f"{timestamp}{raw_body.decode('utf-8', errors='replace')}"
        expected = hmac.new(
            secret.encode(), string_to_sign.encode(), hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected, signature)

    async def send_message(self, message: OutgoingMessage) -> bool:
        """发送消息。"""
        try:
            token = await self._refresh_access_token()
            url = f"{_FEISHU_API_BASE}/im/v1/messages?receive_id_type=chat_id"

            msg_type = "text" if message.message_type == "text" else "interactive"
            content_payload = {"text": message.content}
            if message.message_type == "markdown":
                msg_type = "interactive"
                content_payload = {
                    "config": {"wide_screen_mode": True},
                    "header": {"title": {"tag": "plain_text", "content": "Agent 通知"}},
                    "elements": [{
                        "tag": "markdown",
                        "content": message.content,
                    }],
                }

            payload = {
                "receive_id": message.chat_id,
                "msg_type": msg_type,
                "content": json.dumps(content_payload, ensure_ascii=False),
            }

            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            }
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload, headers=headers)
                data = resp.json()

            if data.get("code", 0) != 0:
                logger.error('飞书发送失败: %s', data)
                return False
            return True

        except Exception as e:
            logger.error('飞书发送异常: %s', e)
            self._status = AdapterStatus.ERROR
            return False

    async def health_check(self) -> HeartbeatStatus:
        start = time.time()
        try:
            await self._refresh_access_token()
            if self._use_long_connection() and not self._is_long_connection_active():
                raise RuntimeError(self._long_conn_error or '飞书长连接未建立')
            latency = (time.time() - start) * 1000
            self._status = AdapterStatus.CONNECTED
            return HeartbeatStatus(
                platform=PlatformType.FEISHU,
                status=AdapterStatus.CONNECTED,
                last_heartbeat=time.time(),
                latency_ms=latency,
            )
        except Exception as e:
            self._status = AdapterStatus.ERROR
            return HeartbeatStatus(
                platform=PlatformType.FEISHU,
                status=AdapterStatus.ERROR,
                last_heartbeat=time.time(),
                error=str(e),
            )

    def parse_webhook(self, payload: dict) -> list:
        """解析飞书事件订阅消息。"""
        messages = []

        # URL 验证由 webhook API 入口直接返回 challenge
        if "challenge" in payload:
            logger.info('收到飞书 challenge 校验请求')
            return messages

        try:
            event = payload.get("event", {})
            message_data = event.get("message", {})

            content_str = message_data.get("content", "{}")
            try:
                content_obj = json.loads(content_str)
                content = content_obj.get("text", content_str)
            except (json.JSONDecodeError, TypeError):
                content = content_str

            chat_id = message_data.get("chat_id", "")
            sender = event.get("sender", {})
            sender_id = sender.get("sender_id", {}).get("user_id", "")
            msg_id = message_data.get("message_id", "")

            logger.info('收到飞书 webhook 消息: chat_id=%s user_id=%s message_id=%s', chat_id, sender_id, msg_id)

            messages.append(IncomingMessage(
                message_id=msg_id,
                platform=PlatformType.FEISHU,
                chat_id=chat_id,
                user_id=sender_id,
                content=content.strip(),
                raw_payload=payload,
                timestamp=event.get("ts", time.time()),
            ))

        except Exception as e:
            logger.error('解析飞书 webhook 失败: %s', e)

        return messages
