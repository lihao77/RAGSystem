"""
结构化日志系统

使用 structlog 提供统一的结构化日志接口，支持：
- JSON 格式输出
- 上下文绑定（agent_name, session_id, trace_id）
- 性能指标记录（duration_ms, token_usage）
- 多级别日志（debug, info, warning, error）
"""

import logging
import sys
import time
from typing import Any, Dict, Optional
from contextlib import contextmanager

try:
    import structlog
    STRUCTLOG_AVAILABLE = True
except ImportError:
    STRUCTLOG_AVAILABLE = False
    import warnings
    warnings.warn("structlog not installed, falling back to standard logging")


class StructuredLogger:
    """结构化日志器"""

    def __init__(self, name: str = "agent"):
        self.name = name
        if STRUCTLOG_AVAILABLE:
            self.logger = structlog.get_logger(name)
        else:
            self.logger = logging.getLogger(name)

    def bind(self, **kwargs) -> 'StructuredLogger':
        """绑定上下文信息"""
        if STRUCTLOG_AVAILABLE:
            new_logger = StructuredLogger(self.name)
            new_logger.logger = self.logger.bind(**kwargs)
            return new_logger
        else:
            # 标准 logging 不支持 bind，返回自身
            return self

    def debug(self, event: str, **kwargs):
        """调试日志"""
        if STRUCTLOG_AVAILABLE:
            self.logger.debug(event, **kwargs)
        else:
            self.logger.debug(f"{event} {kwargs}")

    def info(self, event: str, **kwargs):
        """信息日志"""
        if STRUCTLOG_AVAILABLE:
            self.logger.info(event, **kwargs)
        else:
            self.logger.info(f"{event} {kwargs}")

    def warning(self, event: str, **kwargs):
        """警告日志"""
        if STRUCTLOG_AVAILABLE:
            self.logger.warning(event, **kwargs)
        else:
            self.logger.warning(f"{event} {kwargs}")

    def error(self, event: str, **kwargs):
        """错误日志"""
        if STRUCTLOG_AVAILABLE:
            self.logger.error(event, **kwargs)
        else:
            self.logger.error(f"{event} {kwargs}")

    @contextmanager
    def timed_operation(self, operation: str, **context):
        """
        计时上下文管理器

        用法:
            with logger.timed_operation("tool_call", tool_name="query_kg"):
                result = execute_tool(...)
        """
        start_time = time.time()
        try:
            yield
        finally:
            duration_ms = int((time.time() - start_time) * 1000)
            self.info(
                f"{operation}_completed",
                operation=operation,
                duration_ms=duration_ms,
                **context
            )


def configure_logging(
    log_level: str = "INFO",
    json_output: bool = True,
    log_file: Optional[str] = None
):
    """
    配置全局日志系统

    Args:
        log_level: 日志级别 (DEBUG, INFO, WARNING, ERROR)
        json_output: 是否输出 JSON 格式
        log_file: 日志文件路径（可选）
    """
    if not STRUCTLOG_AVAILABLE:
        # 配置标准 logging
        logging.basicConfig(
            level=getattr(logging, log_level.upper()),
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=[
                logging.StreamHandler(sys.stdout),
                *([logging.FileHandler(log_file)] if log_file else [])
            ]
        )
        return

    # 配置 structlog
    processors = [
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
    ]

    if json_output:
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(structlog.dev.ConsoleRenderer())

    structlog.configure(
        processors=processors,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # 配置标准 logging（structlog 的后端）
    logging.basicConfig(
        format="%(message)s",
        level=getattr(logging, log_level.upper()),
        handlers=[
            logging.StreamHandler(sys.stdout),
            *([logging.FileHandler(log_file)] if log_file else [])
        ]
    )


def get_logger(name: str = "agent", **context) -> StructuredLogger:
    """
    获取结构化日志器

    Args:
        name: 日志器名称
        **context: 初始上下文（如 agent_name, session_id）

    Returns:
        StructuredLogger 实例

    示例:
        logger = get_logger("qa_agent", session_id="abc-123")
        logger.info("tool_call", tool_name="query_kg", duration_ms=1234)
    """
    logger = StructuredLogger(name)
    if context:
        logger = logger.bind(**context)
    return logger
