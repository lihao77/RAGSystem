# -*- coding: utf-8 -*-
"""
社交平台适配器抽象基类。

所有平台适配器必须实现此接口，由消息网关统一调度。
"""

from abc import ABC, abstractmethod
import logging
from typing import List

from daemon.models import (
    AdapterStatus,
    HeartbeatStatus,
    IncomingMessage,
    OutgoingMessage,
    PlatformConnection,
)

logger = logging.getLogger(__name__)


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

    @abstractmethod
    async def health_check(self) -> HeartbeatStatus:
        """执行健康检查，返回心跳状态。"""
        ...

    def verify_webhook_signature(self, headers: dict, raw_body: bytes) -> bool:
        """验证 Webhook 回调签名。子类应覆盖以实现平台签名校验。"""
        logger.warning(
            '%s 未实现 webhook 签名校验，所有请求将被放行（安全风险）',
            type(self).__name__,
        )
        return True

    @abstractmethod
    def parse_webhook(self, payload: dict) -> List[IncomingMessage]:
        """
        解析平台 webhook 回调数据为 IncomingMessage 列表。

        Args:
            payload: 平台原始回调 JSON

        Returns:
            IncomingMessage 列表（单条回调可能包含多条消息）
        """
        ...
