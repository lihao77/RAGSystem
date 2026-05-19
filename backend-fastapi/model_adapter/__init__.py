"""
Model Adapter - 统一的 AI 模型调用适配器

提供统一的接口来调用不同的大语言模型和 Embedding 服务，
支持 OpenAI、DeepSeek、OpenRouter 等主流 AI 服务。
"""

from .base import AIProvider, ModelResponse, EmbeddingResponse


def __getattr__(name):
    if name in {"ModelAdapter", "get_default_adapter", "set_default_adapter"}:
        from .adapter import ModelAdapter, get_default_adapter, set_default_adapter

        values = {
            "ModelAdapter": ModelAdapter,
            "get_default_adapter": get_default_adapter,
            "set_default_adapter": set_default_adapter,
        }
        return values[name]

    if name in {"OpenAIProvider", "DeepSeekProvider", "OpenRouterProvider", "ModelScopeProvider", "RerankAPIProvider"}:
        from .providers import (
            DeepSeekProvider,
            ModelScopeProvider,
            OpenAIProvider,
            OpenRouterProvider,
            RerankAPIProvider,
        )

        values = {
            "OpenAIProvider": OpenAIProvider,
            "DeepSeekProvider": DeepSeekProvider,
            "OpenRouterProvider": OpenRouterProvider,
            "ModelScopeProvider": ModelScopeProvider,
            "RerankAPIProvider": RerankAPIProvider,
        }
        return values[name]

    raise AttributeError(f"module 'model_adapter' has no attribute {name!r}")

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
    "RerankAPIProvider",
]
