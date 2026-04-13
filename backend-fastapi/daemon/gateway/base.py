# -*- coding: utf-8 -*-
"""
社交平台适配器抽象基类。

所有平台适配器必须实现此接口，由消息网关统一调度。
"""

from abc import ABC, abstractmethod
from typing import Any

from daemon.models import (
    AdapterStatus,
    HeartbeatStatus,
    OutgoingMessage,
    PlatformConnection,
)


class PlatformAdapter(ABC):
    """社交平台适配器基类。"""

    def __init__(self, config: PlatformConnection):
        self._config = config
        self._status: AdapterStatus = AdapterStatus.DISCONNECTED

    @property
    def status(self) -> AdapterStatus:
        return self._status

    @abstractmethod
    async def connect(self) -> None:
        """建立与平台的连接。"""
        ...

    @abstractmethod
    async def disconnect(self) -> None:
        """断开与平台的连接。"""
        ...

    @abstractmethod
    async def send_message(self, message: OutgoingMessage) -> bool:
        """
        发送消息到平台。

        Returns:
            True 表示发送成功，False 表示失败
        """
        ...

    def get_status(self) -> AdapterStatus:
        """返回当前连接状态。"""
        return self._status

    @abstractmethod
    async def health_check(self) -> HeartbeatStatus:
        """执行健康检查，返回心跳状态。"""
        ...

    def verify_webhook_signature(self, headers: dict, raw_body: bytes) -> bool:
        """验证 Webhook 回调签名。子类应覆盖以实现平台签名校验。"""
        return True

    @abstractmethod
    def parse_webhook(self, payload: dict) -> list:
        """
        解析平台 webhook 回调数据为 IncomingMessage 列表。

        Args:
            payload: 平台原始回调 JSON

        Returns:
            IncomingMessage 列表（单条回调可能包含多条消息）
        """
        ...
