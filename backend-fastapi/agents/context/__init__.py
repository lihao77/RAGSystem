# -*- coding: utf-8 -*-
"""
Context - 智能体上下文管理
"""

from .config import ContextConfig
from .observation_formatter import ObservationFormatter
from .observation_formatters import (
    BaseObservationFormatter,
    FormatContext,
    get_default_registry,
    ObservationFormatterRegistry,
)
from .token_counter import TokenCounter
from .budget import compute_context_budget
from .pipeline import ContextPipeline

__all__ = [
    'ContextConfig',
    'ObservationFormatter',
    'TokenCounter',
    'compute_context_budget',
    'ContextPipeline',
    # 策略化相关
    'BaseObservationFormatter',
    'FormatContext',
    'ObservationFormatterRegistry',
    'get_default_registry',
]
