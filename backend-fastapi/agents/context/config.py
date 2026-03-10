# -*- coding: utf-8 -*-
"""Context configuration models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class ContextConfig:
    """上下文管理配置"""

    max_tokens: int = 8000
    model_name: Optional[str] = None
    compression_trigger_ratio: float = 0.85
    summarize_max_tokens: int = 300
    preserve_recent_turns: int = 3
