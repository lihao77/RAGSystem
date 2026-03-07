"""
ModelScope Provider 实现。
"""

from typing import List, Optional

from model_adapter.base import AIProviderType, EmbeddingResponse
from .openai_provider import OpenAIProvider


class ModelScopeProvider(OpenAIProvider):
    """ModelScope Provider 实现。"""

    def __init__(self, api_key: str, model: str = 'Qwen/Qwen3-Embedding-8B', name: str = 'ModelScope', **kwargs):
        api_endpoint = kwargs.pop('api_endpoint', 'https://api-inference.modelscope.cn/v1')
        super().__init__(
            api_key=api_key,
            model=model,
            name=name,
            api_endpoint=api_endpoint,
            **kwargs,
        )

    def embed(
        self,
        texts: List[str],
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        **kwargs,
    ) -> EmbeddingResponse:
        kwargs['encoding_format'] = 'float'
        return super().embed(texts, model, dimensions, **kwargs)

    def _get_provider_type(self) -> AIProviderType:
        return AIProviderType.MODELSCOPE

    def get_model_list(self) -> List[str]:
        return [
            'Qwen/Qwen3-Embedding-8B',
            'Qwen/Qwen2.5-72B-Instruct',
            'Qwen/Qwen2.5-7B-Instruct',
        ]
