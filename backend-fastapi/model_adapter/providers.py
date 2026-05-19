"""
AI Provider 兼容导出层。

实际厂商实现已迁移到 `backend/integrations/model_providers/`。
本模块保留原导入路径，避免影响现有调用方。
"""

from integrations.model_providers.anthropic_provider import AnthropicProvider
from integrations.model_providers.common import CancellableRequest, InterruptedError
from integrations.model_providers.deepseek_provider import DeepSeekProvider
from integrations.model_providers.factory import create_provider_from_config
from integrations.model_providers.modelscope_provider import ModelScopeProvider
from integrations.model_providers.openai_provider import OpenAIProvider
from integrations.model_providers.openrouter_provider import OpenRouterProvider
from integrations.model_providers.rerank_api_provider import RerankAPIProvider

__all__ = [
    'InterruptedError',
    'CancellableRequest',
    'OpenAIProvider',
    'AnthropicProvider',
    'DeepSeekProvider',
    'OpenRouterProvider',
    'ModelScopeProvider',
    'RerankAPIProvider',
    'create_provider_from_config',
]
