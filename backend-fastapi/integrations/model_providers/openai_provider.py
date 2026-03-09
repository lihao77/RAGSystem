"""
OpenAI Provider 实现。
"""

from typing import List

from model_adapter.base import AIProviderType
from .openai_compatible_provider import OpenAICompatibleProvider


class OpenAIProvider(OpenAICompatibleProvider):
    """OpenAI Provider 实现。"""

    def __init__(self, api_key: str, model: str = 'gpt-3.5-turbo', name: str = 'OpenAI', **kwargs):
        api_endpoint = kwargs.pop('api_endpoint', 'https://api.openai.com/v1')
        super().__init__(
            name=name,
            api_key=api_key,
            api_endpoint=api_endpoint,
            model=model,
            **kwargs,
        )
        self.supports_function_calling = kwargs.get('supports_function_calling', True)
        self.headers = {
            'Authorization': f'Bearer {self.api_key}',
            'Content-Type': 'application/json',
        }

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.OPENAI

    def get_model_list(self) -> List[str]:
        return [
            'gpt-4-turbo-preview',
            'gpt-4',
            'gpt-3.5-turbo',
            'text-embedding-3-small',
            'text-embedding-3-large',
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        pricing = {
            'gpt-4': {'input': 0.03 / 1000, 'output': 0.06 / 1000},
            'gpt-3.5-turbo': {'input': 0.0015 / 1000, 'output': 0.002 / 1000},
            'text-embedding-3-small': {'input': 0.00002 / 1000, 'output': 0},
        }
        price = pricing.get(model)
        if not price:
            if 'gpt-4' in model:
                price = pricing['gpt-4']
            else:
                price = pricing['gpt-3.5-turbo']
        return input_tokens * price['input'] + output_tokens * price['output']
