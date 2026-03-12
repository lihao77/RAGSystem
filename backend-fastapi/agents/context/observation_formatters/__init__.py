# -*- coding: utf-8 -*-
"""
Observation Formatter 策略化模块

使用策略模式处理不同类型的工具输出格式化。
"""

from .base import BaseObservationFormatter, FormatContext
from .registry import ObservationFormatterRegistry, get_default_registry
from .fallback import FallbackFormatter
from .skills import SkillsObservationFormatter
from .chart import ChartObservationFormatter
from .map import MapObservationFormatter
from .json_data import JsonDataFormatter
from .text import TextDataFormatter
from .large_payload import LargePayloadFormatter

__all__ = [
    # 基类
    'BaseObservationFormatter',
    'FormatContext',
    # 注册表
    'ObservationFormatterRegistry',
    'get_default_registry',
    # 具体策略
    'FallbackFormatter',
    'SkillsObservationFormatter',
    'ChartObservationFormatter',
    'MapObservationFormatter',
    'JsonDataFormatter',
    'TextDataFormatter',
    'LargePayloadFormatter',
]
