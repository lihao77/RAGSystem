"""
通用重试装饰器

为工具调用和 LLM 调用提供统一的重试机制。
"""

import time
import logging
from typing import Callable, Type, Tuple, Optional
from functools import wraps

logger = logging.getLogger(__name__)


def retry_on_failure(
    max_retries: int = 3,
    backoff_factor: float = 2.0,
    retry_on: Tuple[Type[Exception], ...] = (ConnectionError, TimeoutError),
    timeout: Optional[float] = None,
    on_retry: Optional[Callable] = None
):
    """
    重试装饰器

    Args:
        max_retries: 最大重试次数
        backoff_factor: 退避因子（每次重试等待时间 = backoff_factor ^ retry_count）
        retry_on: 可重试的异常类型元组
        timeout: 超时时间（秒），None 表示无超时
        on_retry: 重试回调函数，接收 (attempt, exception, wait_time) 参数

    示例:
        @retry_on_failure(
            max_retries=3,
            backoff_factor=2.0,
            retry_on=(ConnectionError, TimeoutError),
            timeout=30.0
        )
        def execute_tool(tool_name, arguments):
            # 工具执行逻辑
            pass
    """
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None
            start_time = time.time()

            for attempt in range(max_retries + 1):
                try:
                    # 检查超时
                    if timeout and (time.time() - start_time) > timeout:
                        raise TimeoutError(
                            f"操作超时（{timeout}秒），已尝试 {attempt} 次"
                        )

                    # 执行函数
                    return func(*args, **kwargs)

                except retry_on as e:
                    last_exception = e

                    # 如果已达最大重试次数，抛出异常
                    if attempt >= max_retries:
                        logger.error(
                            f"{func.__name__} 失败，已达最大重试次数 ({max_retries}): {e}"
                        )
                        raise

                    # 计算等待时间（指数退避）
                    wait_time = backoff_factor ** attempt
                    logger.warning(
                        f"{func.__name__} 失败，{wait_time:.1f}秒后重试 "
                        f"({attempt + 1}/{max_retries}): {e}"
                    )

                    # 调用重试回调
                    if on_retry:
                        try:
                            on_retry(attempt + 1, e, wait_time)
                        except Exception as callback_error:
                            logger.error(f"重试回调失败: {callback_error}")

                    # 等待后重试
                    time.sleep(wait_time)

                except Exception as e:
                    # 不可重试的异常，直接抛出
                    logger.error(f"{func.__name__} 失败（不可重试）: {e}")
                    raise

            # 理论上不会到达这里，但为了安全起见
            if last_exception:
                raise last_exception

        return wrapper
    return decorator


def retry_async(
    max_retries: int = 3,
    backoff_factor: float = 2.0,
    retry_on: Tuple[Type[Exception], ...] = (ConnectionError, TimeoutError),
    timeout: Optional[float] = None,
    on_retry: Optional[Callable] = None
):
    """
    异步重试装饰器（用于 async 函数）

    Args:
        max_retries: 最大重试次数
        backoff_factor: 退避因子
        retry_on: 可重试的异常类型元组
        timeout: 超时时间（秒）
        on_retry: 重试回调函数

    示例:
        @retry_async(max_retries=3, backoff_factor=2.0)
        async def async_tool_call():
            # 异步工具调用逻辑
            pass
    """
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            import asyncio

            last_exception = None
            start_time = time.time()

            for attempt in range(max_retries + 1):
                try:
                    # 检查超时
                    if timeout and (time.time() - start_time) > timeout:
                        raise TimeoutError(
                            f"操作超时（{timeout}秒），已尝试 {attempt} 次"
                        )

                    # 执行异步函数
                    return await func(*args, **kwargs)

                except retry_on as e:
                    last_exception = e

                    if attempt >= max_retries:
                        logger.error(
                            f"{func.__name__} 失败，已达最大重试次数 ({max_retries}): {e}"
                        )
                        raise

                    wait_time = backoff_factor ** attempt
                    logger.warning(
                        f"{func.__name__} 失败，{wait_time:.1f}秒后重试 "
                        f"({attempt + 1}/{max_retries}): {e}"
                    )

                    if on_retry:
                        try:
                            on_retry(attempt + 1, e, wait_time)
                        except Exception as callback_error:
                            logger.error(f"重试回调失败: {callback_error}")

                    await asyncio.sleep(wait_time)

                except Exception as e:
                    logger.error(f"{func.__name__} 失败（不可重试）: {e}")
                    raise

            if last_exception:
                raise last_exception

        return wrapper
    return decorator
