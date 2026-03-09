"""
错误分类器

区分可重试错误和不可重试错误，避免无效重试。
"""

import re
from enum import Enum
from typing import Type
from .exceptions import (
    RetryableError,
    NonRetryableError,
    RateLimitError,
    NetworkError,
    TimeoutError as AgentTimeoutError,
    ValidationError,
    PermissionError,
    ConfigurationError
)


class ErrorType(Enum):
    """错误类型"""
    RETRYABLE = "retryable"                      # 可重试
    RETRYABLE_WITH_BACKOFF = "retryable_backoff"  # 可重试（需退避）
    NON_RETRYABLE = "non_retryable"              # 不可重试
    UNKNOWN = "unknown"                          # 未知


class ErrorClassifier:
    """
    错误分类器

    根据异常类型和错误消息，判断错误是否可重试。
    """

    # 可重试的异常类型
    RETRYABLE_EXCEPTIONS = (
        ConnectionError,
        TimeoutError,
        AgentTimeoutError,
        NetworkError,
        RetryableError,
    )

    # 不可重试的异常类型
    NON_RETRYABLE_EXCEPTIONS = (
        ValueError,
        KeyError,
        TypeError,
        AttributeError,
        ValidationError,
        PermissionError,
        ConfigurationError,
        NonRetryableError,
    )

    # 速率限制相关的异常
    RATE_LIMIT_EXCEPTIONS = (
        RateLimitError,
    )

    # 错误消息模式（用于识别特定错误类型）
    RATE_LIMIT_PATTERNS = [
        r"rate limit",
        r"too many requests",
        r"quota exceeded",
        r"请求过于频繁",
        r"超出配额",
    ]

    NETWORK_PATTERNS = [
        r"connection (refused|reset|timeout|error)",
        r"network (error|timeout|unreachable)",
        r"dns resolution failed",
        r"连接(被拒绝|超时|错误)",
        r"网络(错误|超时|不可达)",
    ]

    TIMEOUT_PATTERNS = [
        r"timeout",
        r"timed out",
        r"超时",
    ]

    PERMISSION_PATTERNS = [
        r"permission denied",
        r"unauthorized",
        r"forbidden",
        r"access denied",
        r"权限不足",
        r"未授权",
        r"禁止访问",
    ]

    VALIDATION_PATTERNS = [
        r"invalid (argument|parameter|input|value)",
        r"validation (error|failed)",
        r"参数(错误|无效)",
        r"验证失败",
    ]

    @classmethod
    def classify(cls, error: Exception) -> ErrorType:
        """
        分类错误

        Args:
            error: 异常对象

        Returns:
            ErrorType: 错误类型
        """
        # 1. 检查异常类型
        if isinstance(error, cls.RATE_LIMIT_EXCEPTIONS):
            return ErrorType.RETRYABLE_WITH_BACKOFF

        if isinstance(error, cls.RETRYABLE_EXCEPTIONS):
            return ErrorType.RETRYABLE

        if isinstance(error, cls.NON_RETRYABLE_EXCEPTIONS):
            return ErrorType.NON_RETRYABLE

        # 2. 检查错误消息
        error_message = str(error).lower()

        # 速率限制
        if cls._match_patterns(error_message, cls.RATE_LIMIT_PATTERNS):
            return ErrorType.RETRYABLE_WITH_BACKOFF

        # 网络错误
        if cls._match_patterns(error_message, cls.NETWORK_PATTERNS):
            return ErrorType.RETRYABLE

        # 超时错误
        if cls._match_patterns(error_message, cls.TIMEOUT_PATTERNS):
            return ErrorType.RETRYABLE

        # 权限错误
        if cls._match_patterns(error_message, cls.PERMISSION_PATTERNS):
            return ErrorType.NON_RETRYABLE

        # 验证错误
        if cls._match_patterns(error_message, cls.VALIDATION_PATTERNS):
            return ErrorType.NON_RETRYABLE

        # 3. 未知错误（保守策略：不重试）
        return ErrorType.UNKNOWN

    @classmethod
    def is_retryable(cls, error: Exception) -> bool:
        """
        判断错误是否可重试

        Args:
            error: 异常对象

        Returns:
            bool: 是否可重试
        """
        error_type = cls.classify(error)
        return error_type in (ErrorType.RETRYABLE, ErrorType.RETRYABLE_WITH_BACKOFF)

    @classmethod
    def should_backoff(cls, error: Exception) -> bool:
        """
        判断是否需要退避（更长的等待时间）

        Args:
            error: 异常对象

        Returns:
            bool: 是否需要退避
        """
        return cls.classify(error) == ErrorType.RETRYABLE_WITH_BACKOFF

    @classmethod
    def _match_patterns(cls, text: str, patterns: list) -> bool:
        """
        检查文本是否匹配任一模式

        Args:
            text: 待检查文本
            patterns: 正则表达式模式列表

        Returns:
            bool: 是否匹配
        """
        for pattern in patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return True
        return False

    @classmethod
    def get_retry_config(cls, error: Exception) -> dict:
        """
        根据错误类型获取推荐的重试配置

        Args:
            error: 异常对象

        Returns:
            dict: 重试配置 {max_retries, backoff_factor, timeout}
        """
        error_type = cls.classify(error)

        if error_type == ErrorType.RETRYABLE_WITH_BACKOFF:
            # 速率限制：更长的退避时间
            return {
                "max_retries": 3,
                "backoff_factor": 5.0,  # 5s, 25s, 125s
                "timeout": 180.0
            }
        elif error_type == ErrorType.RETRYABLE:
            # 普通可重试错误：标准退避
            return {
                "max_retries": 3,
                "backoff_factor": 2.0,  # 2s, 4s, 8s
                "timeout": 30.0
            }
        else:
            # 不可重试或未知错误：不重试
            return {
                "max_retries": 0,
                "backoff_factor": 0,
                "timeout": 0
            }
