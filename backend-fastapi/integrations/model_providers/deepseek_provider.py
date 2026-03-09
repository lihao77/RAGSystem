"""
DeepSeek Provider 实现。
"""

from typing import List

from model_adapter.base import AIProviderType
from .openai_compatible_provider import OpenAICompatibleProvider


class DeepSeekProvider(OpenAICompatibleProvider):
    """DeepSeek Provider 实现。"""

    def __init__(self, api_key: str, model: str = 'deepseek-chat', name: str = 'DeepSeek', **kwargs):
        api_endpoint = kwargs.pop('api_endpoint', 'https://api.deepseek.com')
        super().__init__(
            name=name,
            api_key=api_key,
            api_endpoint=api_endpoint,
            model=model,
            **kwargs,
        )
        self.headers = {
            'Authorization': f'Bearer {self.api_key}',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }

    def _should_attach_tools(self) -> bool:
        return True

    def _default_embedding_model(self) -> str:
        return 'deepseek-embedding'

    def _supports_dimensions(self) -> bool:
        return False

    def _error_latency(self, start_time, response_data) -> float:
        return self._after_request(start_time)

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.DEEPSEEK

    def get_model_list(self) -> List[str]:
        return [
            'deepseek-chat',
            'deepseek-coder',
            'deepseek-reasoner',
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        return 0.0
