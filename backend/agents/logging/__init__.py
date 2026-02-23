"""
智能体日志系统

提供结构化日志功能，便于聚合分析和查询。
"""

from .structured_logger import get_logger, configure_logging

__all__ = ['get_logger', 'configure_logging']
