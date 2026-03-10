# -*- coding: utf-8 -*-
"""
核心数据模型 - AgentResponse、Message
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Any, Optional


@dataclass
class AgentResponse:
    """智能体响应"""
    success: bool
    content: str = ""                      # 文本内容
    data: Optional[Dict[str, Any]] = None  # 结构化数据
    metadata: Dict[str, Any] = field(default_factory=dict)  # 元数据
    error: Optional[str] = None            # 错误信息

    # 执行信息
    agent_name: str = ""                   # 执行的智能体名称
    execution_time: float = 0.0            # 执行时间（秒）
    tool_calls: List[Dict] = field(default_factory=list)  # 工具调用记录

    # 评估指标 (Context Self-Management)
    metrics: Dict[str, Any] = field(default_factory=dict)  # 如 usefulness_score

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            'success': self.success,
            'content': self.content,
            'data': self.data,
            'metadata': self.metadata,
            'error': self.error,
            'agent_name': self.agent_name,
            'execution_time': self.execution_time,
            'tool_calls': self.tool_calls
        }


@dataclass
class Message:
    """消息"""
    role: str                              # user, assistant, system
    content: str
    timestamp: datetime = field(default_factory=datetime.now)
    metadata: Dict[str, Any] = field(default_factory=dict)
    seq: Optional[int] = None
