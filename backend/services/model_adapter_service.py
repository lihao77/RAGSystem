# -*- coding: utf-8 -*-
"""
Model Adapter 服务层。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
import logging

from model_adapter import get_default_adapter

logger = logging.getLogger(__name__)


class ModelAdapterServiceError(Exception):
    """Model Adapter 业务异常。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class ModelAdapterService:
    """封装 Model Adapter 的业务逻辑，供路由层调用。"""

    def __init__(self):
        self._adapter = get_default_adapter()

    def list_providers(self) -> List[Dict[str, Any]]:
        return [dict(config) for config in self._adapter.get_provider_configs()]

    def create_provider(self, data: Optional[Dict[str, Any]]) -> str:
        config = self._build_create_config(data)
        return self._adapter.register_provider_from_config(config)

    def update_provider(self, provider_key: str, data: Optional[Dict[str, Any]]) -> str:
        if not data:
            raise ModelAdapterServiceError('请求数据不能为空', status_code=400)

        existing_config = self._adapter.config_store.get_provider(provider_key)
        if not existing_config:
            raise ModelAdapterServiceError(f'Provider 不存在: {provider_key}', status_code=404)

        config = existing_config.copy()
        allowed_fields = [
            'models',
            'temperature',
            'max_tokens',
            'max_completion_tokens',
            'max_context_tokens',
            'timeout',
            'retry_attempts',
            'retry_delay',
            'supports_function_calling',
            'model_map',
            'api_endpoint',
        ]

        for field in allowed_fields:
            if field in data:
                config[field] = data[field]

        self._merge_model_map(config)

        if provider_key in self._adapter.providers:
            self._adapter.remove_provider(provider_key, delete_config=False)

        return self._adapter.register_provider_from_config(config, save_config=True)

    def delete_provider(self, provider_key: str) -> None:
        self._adapter.remove_provider(provider_key, delete_config=True)

    def check_provider_availability(self, provider_key: str) -> Dict[str, Any]:
        provider = self._adapter.providers.get(provider_key)
        if not provider:
            raise ModelAdapterServiceError(f'Provider 不存在: {provider_key}', status_code=404)

        return {
            'provider_key': provider_key,
            'is_available': provider.is_available(),
        }

    def test_provider(self, data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not data:
            raise ModelAdapterServiceError('请求数据不能为空', status_code=400)

        provider = data.get('provider')
        provider_type = data.get('provider_type')
        prompt = data.get('prompt')
        model = data.get('model')
        task = data.get('task', 'chat')

        if not provider:
            raise ModelAdapterServiceError('请提供 Provider', status_code=400)
        if not prompt:
            raise ModelAdapterServiceError('请提供测试内容', status_code=400)

        if task == 'chat':
            response = self._adapter.chat_completion(
                messages=[{'role': 'user', 'content': prompt}],
                provider=provider,
                model=model,
                provider_type=provider_type,
                temperature=0.7,
                max_tokens=500,
            )
            return {
                'content': response.content,
                'error': response.error,
                'model': response.model,
                'provider': response.provider,
                'cost': response.cost,
                'latency': response.latency,
                'usage': response.usage,
                'finish_reason': response.finish_reason,
            }

        if task == 'embedding':
            response = self._adapter.embed(
                texts=[prompt],
                provider=provider,
                model=model,
                provider_type=provider_type,
            )
            return {
                'embeddings': response.embeddings,
                'error': response.error,
                'model': response.model,
                'provider': response.provider,
                'latency': response.latency,
                'usage': response.usage,
            }

        raise ModelAdapterServiceError(f'不支持的任务类型: {task}', status_code=400)

    def _build_create_config(self, data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not data:
            raise ModelAdapterServiceError('请求数据不能为空', status_code=400)

        required_fields = ['provider_type', 'name', 'api_key']
        for field in required_fields:
            if not data.get(field):
                raise ModelAdapterServiceError(f'缺少必需字段: {field}', status_code=400)

        config = data.copy()
        self._merge_model_map(config)
        return config

    @staticmethod
    def _merge_model_map(config: Dict[str, Any]) -> None:
        model_map = config.get('model_map')
        if not model_map:
            return

        current_models = set(config.get('models', []))
        for model in model_map.values():
            if isinstance(model, list):
                for item in model:
                    if item and str(item).strip():
                        current_models.add(str(item).strip())
            elif model and str(model).strip():
                current_models.add(str(model).strip())

        config['models'] = list(current_models)


_model_adapter_service: Optional[ModelAdapterService] = None



def get_model_adapter_service() -> ModelAdapterService:
    try:
        from runtime.container import get_current_runtime_container

        container = get_current_runtime_container()
        if container is not None:
            return container.get_model_adapter_service()
    except Exception:
        pass

    global _model_adapter_service
    if _model_adapter_service is None:
        _model_adapter_service = ModelAdapterService()
    return _model_adapter_service
