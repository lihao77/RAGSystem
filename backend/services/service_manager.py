#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
遗留服务管理器（兼容层）。

说明：
- 新代码应统一通过 `runtime.container.RuntimeContainer` 装配依赖。
- 本模块仅为兼容历史调用而保留，不再作为新的服务装配入口。
"""

from __future__ import annotations

import logging
import warnings
from enum import Enum
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_DEPRECATION_MESSAGE = (
    'services.service_manager 已废弃；请改用 runtime.container.RuntimeContainer '
    '或对应的 get_*_service/get_*_manager 运行时入口。'
)
_warned_service_manager = False


class ServiceStatus(Enum):
    """服务状态枚举。"""

    NOT_CONFIGURED = 'not_configured'
    NOT_INITIALIZED = 'not_initialized'
    INITIALIZING = 'initializing'
    READY = 'ready'
    ERROR = 'error'


class ServiceManager:
    """遗留服务管理器。仅保留兼容行为，不建议继续扩展。"""

    def __init__(self):
        self._services: Dict[str, Dict[str, Any]] = {}
        self._status: Dict[str, ServiceStatus] = {}
        self._errors: Dict[str, Optional[str]] = {}

    def register_service(self, service_name: str, init_func: callable, check_config_func: callable = None):
        self._services[service_name] = {
            'init_func': init_func,
            'check_config_func': check_config_func,
            'instance': None,
        }

        if check_config_func:
            is_configured = check_config_func()
            self._status[service_name] = (
                ServiceStatus.NOT_INITIALIZED if is_configured else ServiceStatus.NOT_CONFIGURED
            )
        else:
            self._status[service_name] = ServiceStatus.NOT_INITIALIZED

    def get_service(self, service_name: str) -> Optional[Any]:
        if service_name not in self._services:
            logger.error('服务未注册: %s', service_name)
            return None

        service = self._services[service_name]
        if service['instance'] is not None:
            return service['instance']

        if self._status[service_name] == ServiceStatus.NOT_CONFIGURED:
            logger.warning('服务未配置: %s', service_name)
            return None

        return self._initialize_service(service_name)

    def _initialize_service(self, service_name: str) -> Optional[Any]:
        service = self._services[service_name]

        try:
            logger.info('正在初始化服务: %s', service_name)
            self._status[service_name] = ServiceStatus.INITIALIZING
            instance = service['init_func']()

            if instance is not None:
                service['instance'] = instance
                self._status[service_name] = ServiceStatus.READY
                self._errors[service_name] = None
                logger.info('✓ 服务初始化成功: %s', service_name)
                return instance

            self._status[service_name] = ServiceStatus.ERROR
            self._errors[service_name] = '初始化返回 None'
            logger.error('✗ 服务初始化失败: %s', service_name)
            return None
        except Exception as error:
            self._status[service_name] = ServiceStatus.ERROR
            self._errors[service_name] = str(error)
            logger.error('✗ 服务初始化异常: %s - %s', service_name, error)
            return None

    def get_status(self, service_name: str) -> Dict[str, Any]:
        if service_name not in self._services:
            return {'status': 'unknown', 'error': '服务未注册'}

        status = self._status[service_name]
        return {
            'status': status.value,
            'error': self._errors.get(service_name),
            'is_ready': status == ServiceStatus.READY,
        }

    def get_all_status(self) -> Dict[str, Dict[str, Any]]:
        return {name: self.get_status(name) for name in self._services.keys()}

    def reinitialize_service(self, service_name: str) -> bool:
        if service_name not in self._services:
            logger.error('服务未注册: %s', service_name)
            return False

        service = self._services[service_name]
        if service['instance'] is not None:
            if hasattr(service['instance'], 'close'):
                try:
                    service['instance'].close()
                except Exception as error:
                    logger.warning('清理服务资源失败: %s - %s', service_name, error)
            service['instance'] = None

        if service['check_config_func']:
            is_configured = service['check_config_func']()
            self._status[service_name] = (
                ServiceStatus.NOT_INITIALIZED if is_configured else ServiceStatus.NOT_CONFIGURED
            )

        if self._status[service_name] != ServiceStatus.NOT_CONFIGURED:
            instance = self._initialize_service(service_name)
            return instance is not None

        return False


_service_manager = ServiceManager()


def get_service_manager() -> ServiceManager:
    """获取遗留服务管理器实例，并发出废弃提示。"""
    global _warned_service_manager

    if not _warned_service_manager:
        warnings.warn(_DEPRECATION_MESSAGE, DeprecationWarning, stacklevel=2)
        logger.warning(_DEPRECATION_MESSAGE)
        _warned_service_manager = True

    return _service_manager
