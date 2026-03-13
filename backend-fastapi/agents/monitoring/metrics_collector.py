"""
性能指标收集器

订阅事件总线，自动收集智能体性能指标。
支持持久化到 JSON 文件，重启后自动加载。
进程退出时自动做一次最终保存，避免节流导致未写盘的数据丢失。
"""

import atexit
import json
import logging
import time
from pathlib import Path
from typing import Dict, Optional
from datetime import datetime
from collections import defaultdict

from ..events.bus import EventBus, EventType
from .models import AgentMetrics, ToolMetrics, ErrorMetrics, SystemMetrics

logger = logging.getLogger(__name__)

# 默认持久化路径：backend/data/agent_metrics.json
_DEFAULT_STORAGE_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_DEFAULT_STORAGE_PATH = _DEFAULT_STORAGE_DIR / "agent_metrics.json"


class MetricsCollector:
    """
    性能指标收集器

    订阅事件总线的关键事件，自动收集和聚合性能指标。
    指标会持久化到 JSON 文件，后端重启后自动加载。
    """

    def __init__(
        self,
        event_bus: Optional[EventBus] = None,
        storage_path: Optional[Path] = None,
        persist_interval_seconds: float = 10.0,
    ):
        """
        初始化指标收集器

        Args:
            event_bus: 事件总线实例（可选，用于自动订阅）
            storage_path: 持久化文件路径（可选，默认 backend/data/agent_metrics.json）
            persist_interval_seconds: 写盘间隔秒数，避免过于频繁 IO
        """
        self.metrics: Dict[str, AgentMetrics] = {}
        self._active_runs: Dict[str, dict] = {}
        self._active_tools: Dict[str, dict] = {}
        self._storage_path = Path(storage_path) if storage_path else _DEFAULT_STORAGE_PATH
        self._persist_interval = persist_interval_seconds
        self._last_persist_time = 0.0

        self._load()

        # 进程退出时强制写盘一次，避免节流或未触发的更新丢失
        atexit.register(self._persist_on_exit)

        if event_bus:
            self.subscribe_to_events(event_bus)

    def _persist_on_exit(self) -> None:
        """atexit 回调：退出时强制保存当前指标"""
        try:
            self._persist(force=True)
            logger.debug("进程退出前已保存指标到 %s", self._storage_path)
        except Exception as e:
            logger.warning("退出时保存指标失败: %s", e)

    def _load(self) -> None:
        """从磁盘加载已持久化的指标（存在且可读时）"""
        if not self._storage_path.exists():
            return
        try:
            with open(self._storage_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                return
            for name, raw in data.items():
                try:
                    self.metrics[name] = AgentMetrics.model_validate(raw)
                except Exception as e:
                    logger.warning("加载智能体指标 %s 失败: %s", name, e)
        except Exception as e:
            logger.warning("加载指标文件失败: %s", e)

    def _persist(self, force: bool = False) -> None:
        """将当前指标写入磁盘（带节流，force=True 时立即写入）"""
        if not force and (time.time() - self._last_persist_time) < self._persist_interval:
            return
        try:
            self._storage_path.parent.mkdir(parents=True, exist_ok=True)
            data = {
                name: m.model_dump(mode="json")
                for name, m in self.metrics.items()
            }
            with open(self._storage_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            self._last_persist_time = time.time()
        except Exception as e:
            logger.warning("持久化指标文件失败: %s", e)

    def subscribe_to_events(self, event_bus: EventBus) -> str:
        """订阅事件总线，返回 subscription_id 以便后续取消"""
        return event_bus.subscribe(
            event_types=[
                EventType.CALL_AGENT_START,
                EventType.CALL_AGENT_END,
                EventType.CALL_TOOL_START,
                EventType.CALL_TOOL_END,
                EventType.AGENT_ERROR,
            ],
            handler=self._dispatch_event,
        )

    def _dispatch_event(self, event):
        """根据事件类型分发到对应处理方法"""
        handlers = {
            EventType.CALL_AGENT_START: self._on_agent_call_start,
            EventType.CALL_AGENT_END: self._on_agent_call_end,
            EventType.CALL_TOOL_START: self._on_tool_start,
            EventType.CALL_TOOL_END: self._on_tool_end,
            EventType.AGENT_ERROR: self._on_error,
        }
        handler = handlers.get(event.type)
        if handler:
            handler(event)

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
        # 优先从 run_info 取 agent_name 和时长；若未收到对应 START（如 orchestrator 的 START 与 END 跨线程/顺序），用 END 的 payload 兜底
        agent_name = None
        duration_ms = 0
        if call_id and call_id in self._active_runs:
            run_info = self._active_runs.pop(call_id)
            agent_name = run_info.get("agent_name")
            duration_ms = int((time.time() - run_info["start_time"]) * 1000)
        if agent_name is None:
            agent_name = event_data.get("agent_name")
        if not agent_name:
            return
        # 后端发送的是布尔 success，不是 status 字符串
        success = event_data.get("success", True)
        if isinstance(success, str):
            success = (success == "success" or success.lower() == "true")

        self._update_agent_metrics(
            agent_name=agent_name,
            duration_ms=duration_ms,
            success=success,
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
        error_message = event_data.get("error") or event_data.get("error_message", "")

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

        # 每次 agent 结束都强制写盘，避免同一次运行里后结束的 agent（如 orchestrator）因节流未写入
        self._persist(force=True)

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

        self._persist()

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

        self._persist()

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

        self._persist(force=True)
