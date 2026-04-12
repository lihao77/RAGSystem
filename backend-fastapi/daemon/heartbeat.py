# -*- coding: utf-8 -*-
"""
心跳监控。

周期性检查各平台适配器的连接健康状态，
支持自动重连和事件发布。
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Any, Dict, List

from daemon.models import (
    AdapterStatus,
    HeartbeatStatus,
    PlatformType,
)
from daemon.gateway.base import PlatformAdapter

if TYPE_CHECKING:
    from daemon.service import DaemonService

logger = logging.getLogger(__name__)

# 最大重连尝试次数
_MAX_RECONNECT_ATTEMPTS = 3
# 重连基础延迟（秒），指数退避
_RECONNECT_BASE_DELAY = 5


class HeartbeatMonitor:
    """心跳监控器。"""

    def __init__(
        self,
        adapters: Dict[PlatformType, PlatformAdapter],
        interval: int,
        daemon_service: Any,
    ):
        self._adapters = adapters
        self._interval = interval
        self._daemon_service = daemon_service
        self._running = False
        self._task: asyncio.Task | None = None
        self._reconnect_counts: Dict[PlatformType, int] = {}

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._monitor_loop())
        logger.info('心跳监控启动，间隔 %ds', self._interval)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _monitor_loop(self) -> None:
        while self._running:
            for platform, adapter in list(self._adapters.items()):
                try:
                    status = await adapter.health_check()
                    self._daemon_service.record_heartbeat(status)

                    if status.status == AdapterStatus.ERROR:
                        await self._handle_error(platform, adapter, status)
                    else:
                        # 连接正常，重置重连计数
                        self._reconnect_counts[platform] = 0

                except Exception as e:
                    logger.error('心跳检查异常 [%s]: %s', platform.value, e)

            await asyncio.sleep(self._interval)

    async def _handle_error(
        self,
        platform: PlatformType,
        adapter: PlatformAdapter,
        status: HeartbeatStatus,
    ) -> None:
        """处理适配器连接异常，尝试重连。"""
        attempts = self._reconnect_counts.get(platform, 0)
        if attempts >= _MAX_RECONNECT_ATTEMPTS:
            logger.error(
                '平台 [%s] 重连已达上限 (%d)，停止重试',
                platform.value, _MAX_RECONNECT_ATTEMPTS,
            )
            return

        delay = _RECONNECT_BASE_DELAY * (2 ** attempts)
        self._reconnect_counts[platform] = attempts + 1
        logger.warning(
            '平台 [%s] 连接异常，%ds 后尝试第 %d 次重连: %s',
            platform.value, delay, attempts + 1, status.error,
        )

        await asyncio.sleep(delay)

        try:
            await adapter.connect()
            self._reconnect_counts[platform] = 0
            logger.info('平台 [%s] 重连成功', platform.value)
        except Exception as e:
            logger.error('平台 [%s] 重连失败: %s', platform.value, e)
