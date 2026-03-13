# -*- coding: utf-8 -*-
"""
Context - 智能体上下文管理
"""

from .config import ContextConfig
from .observation_policy import ObservationDecision, ObservationPolicy
from .observation_formatters import (
    BaseObservationFormatter,
    FormatContext,
    get_default_registry,
    ObservationFormatterRegistry,
)
from .prompt_materializer import PromptMaterializer
from .token_counter import TokenCounter
from .budget import compute_context_budget, get_context_budget_profile
from .pipeline import ContextPipeline

__all__ = [
    'ContextConfig',
    'ObservationDecision',
    'ObservationPolicy',
    'PromptMaterializer',
    'TokenCounter',
    'compute_context_budget',
    'get_context_budget_profile',
    'ContextPipeline',
    # 策略化相关
    'BaseObservationFormatter',
    'FormatContext',
    'ObservationFormatterRegistry',
    'get_default_registry',
]
