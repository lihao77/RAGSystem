"""
OpenRouter Provider 实现。
"""

from typing import List

from model_adapter.base import AIProviderType, EmbeddingResponse
from .openai_compatible_provider import OpenAICompatibleProvider


class OpenRouterProvider(OpenAICompatibleProvider):
    """OpenRouter Provider 实现。"""

    def __init__(self, api_key: str, model: str = 'anthropic/claude-3-sonnet-20240229', name: str = 'OpenRouter', **kwargs):
        api_endpoint = kwargs.pop('api_endpoint', 'https://openrouter.ai/api/v1')
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
            'HTTP-Referer': kwargs.get('site_url', ''),
            'X-Title': kwargs.get('site_name', 'RAGSystem'),
            'Content-Type': 'application/json',
        }

    def _default_embedding_model(self) -> str:
        return 'text-embedding-3-small'

    def _handle_embedding_non_json(self, response, error):
        body_preview = (response.text or '')[:300].strip() or '(空)'
        return EmbeddingResponse(
            embeddings=[],
            error=f'OpenRouter 返回非 JSON (status={response.status_code})，可能不支持 /embeddings 或密钥有误。原始: {error}',
            provider=self.name,
        )

    def _interrupted_latency(self, start_time, response_data) -> float:
        return self._after_request(start_time) if response_data else 0

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.OPENROUTER

    def get_model_list(self) -> List[str]:
        return [
            'anthropic/claude-3-sonnet-20240229',
            'openai/gpt-4-turbo-preview',
        ]

    def calculate_cost(self, input_tokens: int, output_tokens: int, model: str) -> float:
        return 0.0
