"""
Model Adapter - 统一的 AI 模型调用适配器

提供统一的接口来调用不同的大语言模型和 Embedding 服务，
支持 OpenAI、DeepSeek、OpenRouter 等主流 AI 服务。
"""

from .adapter import ModelAdapter, get_default_adapter, set_default_adapter
from .base import AIProvider, ModelResponse, EmbeddingResponse
from .providers import OpenAIProvider, DeepSeekProvider, OpenRouterProvider, ModelScopeProvider

__all__ = [
    "ModelAdapter",
    "get_default_adapter",
    "set_default_adapter",
    "AIProvider",
    "ModelResponse",
    "EmbeddingResponse",
    "OpenAIProvider",
    "DeepSeekProvider",
    "OpenRouterProvider",
    "ModelScopeProvider",
]
