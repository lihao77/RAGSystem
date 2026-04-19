# -*- coding: utf-8 -*-
"""
Provider 工厂。

将 provider_type -> 具体厂商实现的映射收口到 integrations 层。
"""

from __future__ import annotations

from typing import Any, Dict

from .providers_impl import (
    AnthropicProvider,
    DeepSeekProvider,
    ModelScopeProvider,
    OpenAIChatCompletionsProvider,
    OpenAICompatibleProvider,
    OpenAIResponsesProvider,
    OpenRouterProvider,
)

_OPENAI_COMPAT_PROVIDER_TYPES = {
    'deepseek',
    'openrouter',
    'openai_compatible_chat',
    'openai_proxy',
}


def canonicalize_provider_type(provider_type: str, api_mode: str | None = None) -> str:
    raw_provider_type = str(provider_type or '').strip().lower()
    normalized_api_mode = str(api_mode or '').strip().lower()
    if raw_provider_type == 'openai':
        return 'openai_resp' if normalized_api_mode == 'responses' else 'openai_chat'
    if raw_provider_type in {'openai_responses', 'openai_resp'}:
        return 'openai_resp'
    if raw_provider_type in {'openai_chat_completions', 'openai_chat'}:
        return 'openai_chat'
    if raw_provider_type in {'openai_compatible_chat', 'openai_proxy'}:
        return 'openai_proxy'
    return raw_provider_type


def canonicalize_provider_config(config: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(config)
    normalized['provider_type'] = canonicalize_provider_type(
        normalized.get('provider_type'),
        normalized.get('api_mode'),
    )
    return normalized

_DEFAULT_ENDPOINTS = {
    'openai': 'https://api.openai.com/v1',
    'openai_resp': 'https://api.openai.com/v1',
    'openai_chat': 'https://api.openai.com/v1',
    'openai_proxy': 'https://api.openai.com/v1',
    'anthropic': 'https://api.anthropic.com',
    'deepseek': 'https://api.deepseek.com/v1',
    'openrouter': 'https://openrouter.ai/api/v1',
    'modelscope': 'https://api-inference.modelscope.cn/v1',
}

_PROVIDER_CONFIG_FIELDS = {
    'openai': [
        {
            'key': 'reasoning_effort',
            'label': '推理强度',
            'type': 'select',
            'default': '',
            'help': '仅对支持 reasoning_effort 的 OpenAI 推理模型生效；留空则使用模型默认值。',
            'options': [
                {'value': '', 'label': '模型默认'},
                {'value': 'none', 'label': 'None'},
                {'value': 'minimal', 'label': 'Minimal'},
                {'value': 'low', 'label': 'Low'},
                {'value': 'medium', 'label': 'Medium'},
                {'value': 'high', 'label': 'High'},
                {'value': 'xhigh', 'label': 'XHigh'},
            ],
        },
    ],
    'anthropic': [],
    'deepseek': [],
    'openrouter': [],
    'modelscope': [],
}

_PROVIDER_CLASSES = {
    'openai_resp': OpenAIResponsesProvider,
    'openai_chat': OpenAIChatCompletionsProvider,
    'openai_proxy': OpenAICompatibleProvider,
    'anthropic': AnthropicProvider,
    'deepseek': DeepSeekProvider,
    'openrouter': OpenRouterProvider,
    'modelscope': ModelScopeProvider,
}


def create_provider_from_config(config: Dict[str, Any]):
    normalized = canonicalize_provider_config(config)
    provider_type = normalized.get('provider_type')
    name = normalized.get('name')
    api_key = normalized.get('api_key')
    api_endpoint = normalized.get('api_endpoint')
    model = normalized.get('model', 'gpt-3.5-turbo')

    if not all([name, provider_type, api_key]):
        raise ValueError('Provider 配置必须包含 name, provider_type, api_key')

    provider_class = _PROVIDER_CLASSES.get(provider_type)
    if provider_class is None:
        raise ValueError(f'不支持的 Provider 类型: {provider_type}')

    provider_kwargs = {
        key: value
        for key, value in normalized.items()
        if key not in ['provider_type', 'name', 'api_key', 'api_endpoint', 'models', 'model']
    }

    return provider_class(
        api_key=api_key,
        model=model,
        name=name,
        api_endpoint=api_endpoint or _DEFAULT_ENDPOINTS[provider_type],
        **provider_kwargs,
    )
