"""
AI Provider 兼容导出层。

实际厂商实现已迁移到 `backend/integrations/model_providers/`。
本模块保留原导入路径，避免影响现有调用方。
"""

from integrations.model_providers import (
    CancellableRequest,
    DeepSeekProvider,
    InterruptedError,
    ModelScopeProvider,
    OpenAIProvider,
    OpenRouterProvider,
    create_provider_from_config,
)

__all__ = [
    'InterruptedError',
    'CancellableRequest',
    'OpenAIProvider',
    'DeepSeekProvider',
    'OpenRouterProvider',
    'ModelScopeProvider',
    'create_provider_from_config',
]
