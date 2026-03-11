"""
智能体监控系统

提供性能指标收集和查询功能。
"""

from .observation_window import ObservationWindowCollector

try:
    from .metrics_collector import MetricsCollector
    from .models import AgentMetrics, ToolMetrics, ErrorMetrics
except ModuleNotFoundError:  # pragma: no cover - optional dependency guard
    MetricsCollector = None
    AgentMetrics = None
    ToolMetrics = None
    ErrorMetrics = None

__all__ = ['MetricsCollector', 'AgentMetrics', 'ToolMetrics', 'ErrorMetrics', 'ObservationWindowCollector']
