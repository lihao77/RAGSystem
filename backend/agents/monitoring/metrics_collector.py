"""
性能指标收集器

订阅事件总线，自动收集智能体性能指标。
"""

import time
from typing import Dict, Optional
from datetime import datetime
from collections import defaultdict

from ..events.bus import EventBus, EventType
from .models import AgentMetrics, ToolMetrics, ErrorMetrics, SystemMetrics


class MetricsCollector:
    """
    性能指标收集器

    订阅事件总线的关键事件，自动收集和聚合性能指标。
    """

    def __init__(self, event_bus: Optional[EventBus] = None):
        """
        初始化指标收集器

        Args:
            event_bus: 事件总线实例（可选，用于自动订阅）
        """
        self.metrics: Dict[str, AgentMetrics] = {}
        self._active_runs: Dict[str, dict] = {}  # 跟踪进行中的运行
        self._active_tools: Dict[str, dict] = {}  # 跟踪进行中的工具调用

        if event_bus:
            self.subscribe_to_events(event_bus)

    def subscribe_to_events(self, event_bus: EventBus):
        """订阅事件总线"""
        # 订阅智能体调用事件（包含 agent_name）
        event_bus.subscribe([EventType.CALL_AGENT_START], self._on_agent_call_start)
        event_bus.subscribe([EventType.CALL_AGENT_END], self._on_agent_call_end)
        # 订阅工具调用事件
        event_bus.subscribe([EventType.CALL_TOOL_START], self._on_tool_start)
        event_bus.subscribe([EventType.CALL_TOOL_END], self._on_tool_end)
        # 订阅错误事件
        event_bus.subscribe([EventType.ERROR], self._on_error)

    def _on_agent_call_start(self, event):
        """处理 CALL_AGENT_START 事件"""
        event_data = event.data if hasattr(event, 'data') else event
        call_id = event_data.get("call_id")
        if call_id:
            self._active_runs[call_id] = {
                "start_time": time.time(),
                "agent_name": event_data.get("agent_name"),
                "session_id": getattr(event, 'session_id', None),
            }

    def _on_agent_call_end(self, event):
        """处理 CALL_AGENT_END 事件"""
        event_data = event.data if hasattr(event, 'data') else event
        call_id = event_data.get("call_id")
        if call_id not in self._active_runs:
            return

        run_info = self._active_runs.pop(call_id)
        agent_name = run_info["agent_name"]
        duration_ms = int((time.time() - run_info["start_time"]) * 1000)
        status = event_data.get("status", "success")

        # 更新智能体指标
        self._update_agent_metrics(
            agent_name=agent_name,
            duration_ms=duration_ms,
            success=(status == "success"),
            tokens=event_data.get("token_usage", 0)
        )

    def _on_tool_start(self, event):
        """处理 CALL_TOOL_START 事件"""
        event_data = event.data if hasattr(event, 'data') else event
        # EventPublisher 使用 call_id，不是 tool_call_id
        tool_call_id = event_data.get("call_id") or event_data.get("tool_call_id")
        if tool_call_id:
            self._active_tools[tool_call_id] = {
                "start_time": time.time(),
                "tool_name": event_data.get("tool_name"),
                # 从 parent_call_id 反查 agent_name（如果有的话）
                "parent_call_id": event_data.get("parent_call_id"),
            }

    def _on_tool_end(self, event):
        """处理 CALL_TOOL_END 事件"""
        event_data = event.data if hasattr(event, 'data') else event
        # EventPublisher 使用 call_id，不是 tool_call_id
        tool_call_id = event_data.get("call_id") or event_data.get("tool_call_id")
        if tool_call_id not in self._active_tools:
            return

        tool_info = self._active_tools.pop(tool_call_id)
        tool_name = tool_info["tool_name"]
        duration_ms = int((time.time() - tool_info["start_time"]) * 1000)

        # 从 parent_call_id 查找对应的 agent_name
        parent_call_id = tool_info.get("parent_call_id")
        agent_name = None
        if parent_call_id:
            # 从 _active_runs 中查找
            for call_id, run_info in self._active_runs.items():
                if call_id == parent_call_id:
                    agent_name = run_info.get("agent_name")
                    break

        # 如果找不到 agent_name，跳过（避免 None 错误）
        if not agent_name:
            return

        # 判断成功/失败（如果 result 是 dict 且有 success 字段）
        result = event_data.get("result", {})
        if isinstance(result, dict):
            success = result.get("success", True)
        else:
            success = True  # 默认成功

        # 更新工具指标
        self._update_tool_metrics(
            agent_name=agent_name,
            tool_name=tool_name,
            duration_ms=duration_ms,
            success=success
        )

    def _on_error(self, event):
        """处理 ERROR 事件"""
        event_data = event.data if hasattr(event, 'data') else event
        agent_name = event_data.get("agent_name")
        error_type = event_data.get("error_type", "UnknownError")
        error_message = event_data.get("error_message", "")

        if agent_name:
            self._update_error_metrics(
                agent_name=agent_name,
                error_type=error_type,
                error_message=error_message
            )

    def _update_agent_metrics(
        self,
        agent_name: str,
        duration_ms: int,
        success: bool,
        tokens: int = 0
    ):
        """更新智能体指标"""
        if not agent_name:
            return  # 跳过无效的 agent_name

        if agent_name not in self.metrics:
            self.metrics[agent_name] = AgentMetrics(agent_name=agent_name)

        metrics = self.metrics[agent_name]
        metrics.total_calls += 1
        if success:
            metrics.success_count += 1
        else:
            metrics.failure_count += 1

        metrics.total_duration_ms += duration_ms
        metrics.avg_duration_ms = metrics.total_duration_ms / metrics.total_calls

        metrics.total_tokens += tokens
        if tokens > 0:
            metrics.avg_tokens = metrics.total_tokens / metrics.total_calls

        now = datetime.now()
        if not metrics.first_call:
            metrics.first_call = now
        metrics.last_call = now

    def _update_tool_metrics(
        self,
        agent_name: str,
        tool_name: str,
        duration_ms: int,
        success: bool
    ):
        """更新工具指标"""
        if not agent_name or not tool_name:
            return  # 跳过无效的参数

        if agent_name not in self.metrics:
            self.metrics[agent_name] = AgentMetrics(agent_name=agent_name)

        metrics = self.metrics[agent_name]

        # 更新工具使用计数
        if tool_name not in metrics.tool_usage:
            metrics.tool_usage[tool_name] = 0
        metrics.tool_usage[tool_name] += 1

        # 更新详细工具指标
        if tool_name not in metrics.tool_metrics:
            metrics.tool_metrics[tool_name] = ToolMetrics(tool_name=tool_name)

        tool_metrics = metrics.tool_metrics[tool_name]
        tool_metrics.total_calls += 1
        if success:
            tool_metrics.success_count += 1
        else:
            tool_metrics.failure_count += 1

        tool_metrics.total_duration_ms += duration_ms
        tool_metrics.avg_duration_ms = (
            tool_metrics.total_duration_ms / tool_metrics.total_calls
        )

        if tool_metrics.min_duration_ms == 0 or duration_ms < tool_metrics.min_duration_ms:
            tool_metrics.min_duration_ms = duration_ms
        if duration_ms > tool_metrics.max_duration_ms:
            tool_metrics.max_duration_ms = duration_ms

        tool_metrics.last_called = datetime.now()

    def _update_error_metrics(
        self,
        agent_name: str,
        error_type: str,
        error_message: str
    ):
        """更新错误指标"""
        if not agent_name:
            return  # 跳过无效的 agent_name

        if agent_name not in self.metrics:
            self.metrics[agent_name] = AgentMetrics(agent_name=agent_name)

        metrics = self.metrics[agent_name]

        # 更新错误分布
        if error_type not in metrics.error_distribution:
            metrics.error_distribution[error_type] = 0
        metrics.error_distribution[error_type] += 1

        # 更新详细错误指标
        error_metric = next(
            (e for e in metrics.error_metrics if e.error_type == error_type),
            None
        )
        if not error_metric:
            error_metric = ErrorMetrics(error_type=error_type)
            metrics.error_metrics.append(error_metric)

        error_metric.count += 1
        error_metric.last_occurred = datetime.now()
        error_metric.sample_message = error_message[:200]  # 保存前200字符

    def get_agent_metrics(self, agent_name: str) -> Optional[AgentMetrics]:
        """获取指定智能体的指标"""
        return self.metrics.get(agent_name)

    def get_all_metrics(self) -> SystemMetrics:
        """获取系统级指标"""
        system_metrics = SystemMetrics(
            total_agents=len(self.metrics),
            agents=self.metrics
        )

        # 计算系统级聚合指标
        total_calls = sum(m.total_calls for m in self.metrics.values())
        total_success = sum(m.success_count for m in self.metrics.values())
        total_duration = sum(m.total_duration_ms for m in self.metrics.values())

        system_metrics.total_calls = total_calls
        system_metrics.total_duration_ms = total_duration
        if total_calls > 0:
            system_metrics.avg_duration_ms = total_duration / total_calls
            system_metrics.overall_success_rate = total_success / total_calls

        return system_metrics

    def reset_metrics(self, agent_name: Optional[str] = None):
        """
        重置指标

        Args:
            agent_name: 指定智能体名称（可选），不指定则重置所有
        """
        if agent_name:
            if agent_name in self.metrics:
                del self.metrics[agent_name]
        else:
            self.metrics.clear()
            self._active_runs.clear()
            self._active_tools.clear()
