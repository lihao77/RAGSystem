# -*- coding: utf-8 -*-
"""
Observation Formatter 策略化模块

使用策略模式处理不同类型的工具输出格式化。
"""

from .base import BaseObservationFormatter, FormatContext
from .registry import ObservationFormatterRegistry, get_default_registry
from .bash import BashObservationFormatter
from .chart import ChartObservationFormatter
from .fallback import FallbackFormatter
from .glob_fmt import GlobObservationFormatter
from .grep import GrepObservationFormatter
from .json_data import JsonDataFormatter
from .large_payload import LargePayloadFormatter
from .map import MapObservationFormatter
from .skills import SkillsObservationFormatter
from .text import TextDataFormatter
from .web_fetch import WebFetchObservationFormatter

__all__ = [
    # 基类
    'BaseObservationFormatter',
    'FormatContext',
    # 注册表
    'ObservationFormatterRegistry',
    'get_default_registry',
    # 具体策略
    'BashObservationFormatter',
    'ChartObservationFormatter',
    'FallbackFormatter',
    'GlobObservationFormatter',
    'GrepObservationFormatter',
    'JsonDataFormatter',
    'LargePayloadFormatter',
    'MapObservationFormatter',
    'SkillsObservationFormatter',
    'TextDataFormatter',
    'WebFetchObservationFormatter',
]
