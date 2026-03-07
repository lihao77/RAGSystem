# -*- coding: utf-8 -*-
"""
Provider 工厂。

将 provider_type -> 具体厂商实现的映射收口到 integrations 层。
"""

from __future__ import annotations

from typing import Any, Dict

from .providers_impl import (
    DeepSeekProvider,
    ModelScopeProvider,
    OpenAIProvider,
    OpenRouterProvider,
)

_DEFAULT_ENDPOINTS = {
    'openai': 'https://api.openai.com/v1',
    'deepseek': 'https://api.deepseek.com/v1',
    'openrouter': 'https://openrouter.ai/api/v1',
    'modelscope': 'https://api-inference.modelscope.cn/v1',
}

_PROVIDER_CLASSES = {
    'openai': OpenAIProvider,
    'deepseek': DeepSeekProvider,
    'openrouter': OpenRouterProvider,
    'modelscope': ModelScopeProvider,
}


def create_provider_from_config(config: Dict[str, Any]):
    provider_type = config.get('provider_type')
    name = config.get('name')
    api_key = config.get('api_key')
    api_endpoint = config.get('api_endpoint')
    model = config.get('model', 'gpt-3.5-turbo')

    if not all([name, provider_type, api_key]):
        raise ValueError('Provider 配置必须包含 name, provider_type, api_key')

    provider_class = _PROVIDER_CLASSES.get(provider_type)
    if provider_class is None:
        raise ValueError(f'不支持的 Provider 类型: {provider_type}')

    provider_kwargs = {
        key: value
        for key, value in config.items()
        if key not in ['provider_type', 'name', 'api_key', 'api_endpoint', 'models', 'model']
    }

    return provider_class(
        api_key=api_key,
        model=model,
        name=name,
        api_endpoint=api_endpoint or _DEFAULT_ENDPOINTS[provider_type],
        **provider_kwargs,
    )
