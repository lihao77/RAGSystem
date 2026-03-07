# -*- coding: utf-8 -*-
"""
集成层统一异常模型。
"""

from __future__ import annotations


class IntegrationError(RuntimeError):
    """集成层基础异常。"""


class DependencyNotAvailableError(IntegrationError):
    """外部依赖不可用。"""


class ExternalServiceError(IntegrationError):
    """外部服务调用失败。"""


class IntegrationConfigurationError(IntegrationError):
    """集成配置错误。"""


class RequestCancelledError(IntegrationError):
    """外部请求被取消。"""
