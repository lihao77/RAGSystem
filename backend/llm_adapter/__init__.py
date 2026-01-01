"""
LLM Adapter - 统一的 LLM 调用适配器

提供统一的接口来调用不同的大语言模型服务，
支持 OpenAI、DeepSeek、OpenRouter 等主流 LLM 服务。
"""

from .adapter import LLMAdapter, get_default_adapter, set_default_adapter
from .base import LLMProvider, LLMResponse
from .providers import OpenAIProvider, DeepSeekProvider, OpenRouterProvider

__all__ = [
    "LLMAdapter",
    "get_default_adapter",
    "set_default_adapter",
    "LLMProvider",
    "LLMResponse",
    "OpenAIProvider",
    "DeepSeekProvider",
    "OpenRouterProvider",
]
