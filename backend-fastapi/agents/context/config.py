# -*- coding: utf-8 -*-
"""Context configuration models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class ContextConfig:
    """上下文管理配置"""

    max_tokens: int = 8000
    budget_profile: str = "worker"
    model_name: Optional[str] = None
    compression_trigger_ratio: float = 0.85
    summarize_max_tokens: int = 2000
    preserve_recent_turns: int = 3
    # microcompact：保留最近 N 条 observation 消息的完整内容，更旧的内容清除
    microcompact_keep_recent_tools: int = 5
