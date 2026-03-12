# -*- coding: utf-8 -*-
"""
工具模块 - Function Calling工具定义
"""

# 导出响应构造器
from .response_builder import error_result, success_result
from .result_schema import ArtifactRef, ToolExecutionResult

__all__ = [
    'success_result',
    'error_result',
    'ToolExecutionResult',
    'ArtifactRef',
]
