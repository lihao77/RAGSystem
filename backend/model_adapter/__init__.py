"""
Model Adapter - 统一的 AI 模型调用适配器

提供统一的接口来调用不同的大语言模型和 Embedding 服务，
支持 OpenAI、DeepSeek、OpenRouter 等主流 AI 服务。
"""

from .adapter import ModelAdapter, get_default_adapter, set_default_adapter
from .base import AIProvider, ModelResponse, EmbeddingResponse
from .providers import OpenAIProvider, DeepSeekProvider, OpenRouterProvider, ModelScopeProvider

# 兼容旧名称
LLMAdapter = ModelAdapter
LLMProvider = AIProvider
LLMResponse = ModelResponse

__all__ = [
    "ModelAdapter",
    "LLMAdapter",
    "get_default_adapter",
    "set_default_adapter",
    "AIProvider",
    "LLMProvider",
    "ModelResponse",
    "LLMResponse",
    "EmbeddingResponse",
    "OpenAIProvider",
    "DeepSeekProvider",
    "OpenRouterProvider",
    "ModelScopeProvider",
]
