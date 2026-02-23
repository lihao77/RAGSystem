"""
监控数据模型

定义性能指标的数据结构。
"""

from typing import Dict, List, Optional
from pydantic import BaseModel, Field
from datetime import datetime


class ToolMetrics(BaseModel):
    """工具调用指标"""
    tool_name: str
    total_calls: int = 0
    success_count: int = 0
    failure_count: int = 0
    total_duration_ms: int = 0
    avg_duration_ms: float = 0.0
    min_duration_ms: int = 0
    max_duration_ms: int = 0
    last_called: Optional[datetime] = None

    @property
    def success_rate(self) -> float:
        """成功率"""
        if self.total_calls == 0:
            return 0.0
        return self.success_count / self.total_calls


class ErrorMetrics(BaseModel):
    """错误统计"""
    error_type: str
    count: int = 0
    last_occurred: Optional[datetime] = None
    sample_message: Optional[str] = None


class AgentMetrics(BaseModel):
    """智能体性能指标"""
    agent_name: str
    total_calls: int = 0
    success_count: int = 0
    failure_count: int = 0
    total_duration_ms: int = 0
    avg_duration_ms: float = 0.0
    total_tokens: int = 0
    avg_tokens: float = 0.0

    # 工具使用统计
    tool_usage: Dict[str, int] = Field(default_factory=dict)
    tool_metrics: Dict[str, ToolMetrics] = Field(default_factory=dict)

    # 错误分布
    error_distribution: Dict[str, int] = Field(default_factory=dict)
    error_metrics: List[ErrorMetrics] = Field(default_factory=list)

    # 时间戳
    first_call: Optional[datetime] = None
    last_call: Optional[datetime] = None

    @property
    def success_rate(self) -> float:
        """成功率"""
        if self.total_calls == 0:
            return 0.0
        return self.success_count / self.total_calls

    def to_dict(self) -> dict:
        """转换为字典（用于 API 响应）"""
        return {
            "agent_name": self.agent_name,
            "total_calls": self.total_calls,
            "success_rate": round(self.success_rate, 4),
            "avg_duration_ms": round(self.avg_duration_ms, 2),
            "avg_tokens": round(self.avg_tokens, 2),
            "tool_usage": self.tool_usage,
            "error_distribution": self.error_distribution,
            "first_call": self.first_call.isoformat() if self.first_call else None,
            "last_call": self.last_call.isoformat() if self.last_call else None,
        }


class SystemMetrics(BaseModel):
    """系统级指标"""
    total_agents: int = 0
    total_calls: int = 0
    total_duration_ms: int = 0
    avg_duration_ms: float = 0.0
    overall_success_rate: float = 0.0

    # 各智能体指标
    agents: Dict[str, AgentMetrics] = Field(default_factory=dict)

    def to_dict(self) -> dict:
        """转换为字典"""
        return {
            "total_agents": self.total_agents,
            "total_calls": self.total_calls,
            "avg_duration_ms": round(self.avg_duration_ms, 2),
            "overall_success_rate": round(self.overall_success_rate, 4),
            "agents": {
                name: metrics.to_dict()
                for name, metrics in self.agents.items()
            }
        }
