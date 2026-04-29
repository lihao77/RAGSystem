# -*- coding: utf-8 -*-

from __future__ import annotations

from types import SimpleNamespace

import pytest

from services.model_adapter_service import ModelAdapterService, ModelAdapterServiceError


class FakeConfigStore:
    def __init__(self, existing=None):
        self.existing = existing or {}

    def exists(self, provider_key):
        return provider_key in self.existing

    def get_provider(self, provider_key):
        return self.existing.get(provider_key)


class FakeAdapter:
    def __init__(self, existing=None):
        self.config_store = FakeConfigStore(existing)
        self.providers = {}
        self.registered = None
        self.reordered_provider_keys = None
        self.reorder_error = None

    def register_provider_from_config(self, config, save_config=True):
        self.registered = config
        return f"{config['name']}_{config['provider_type']}"

    def remove_provider(self, provider_key, delete_config=False):
        self.providers.pop(provider_key, None)

    def reorder_providers(self, provider_keys):
        if self.reorder_error:
            raise self.reorder_error
        self.reordered_provider_keys = provider_keys
        return provider_keys


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr(
        'services.model_adapter_service.get_default_adapter',
        lambda: FakeAdapter(),
    )
    return ModelAdapterService()


def test_create_provider_rejects_duplicate_key(monkeypatch):
    monkeypatch.setattr(
        'services.model_adapter_service.get_default_adapter',
        lambda: FakeAdapter({'demo_deepseek': {'name': 'demo', 'provider_type': 'deepseek'}}),
    )
    service = ModelAdapterService()

    with pytest.raises(ModelAdapterServiceError) as error:
        service.create_provider({
            'name': 'demo',
            'provider_type': 'deepseek',
            'api_key': 'key',
            'model_map': {'chat': 'deepseek-chat'},
        })

    assert error.value.status_code == 409


def test_create_provider_validates_model_map_shape(service):
    with pytest.raises(ModelAdapterServiceError) as error:
        service.create_provider({
            'name': 'demo',
            'provider_type': 'deepseek',
            'api_key': 'key',
            'model_map': ['deepseek-chat'],
        })

    assert error.value.status_code == 400


def test_test_provider_normalizes_list_model(monkeypatch):
    class Adapter(FakeAdapter):
        def chat_completion(self, **kwargs):
            self.kwargs = kwargs
            return SimpleNamespace(
                content='ok',
                error=None,
                model=kwargs['model'],
                provider='demo',
                cost=None,
                latency=None,
                usage=None,
                finish_reason='stop',
            )

    adapter = Adapter()
    monkeypatch.setattr('services.model_adapter_service.get_default_adapter', lambda: adapter)
    service = ModelAdapterService()

    result = service.test_provider({
        'provider': 'demo',
        'provider_type': 'deepseek',
        'model': ['deepseek-chat', 'deepseek-reasoner'],
        'prompt': 'hi',
        'task': 'chat',
    })

    assert result['model'] == 'deepseek-chat'
    assert adapter.kwargs['model'] == 'deepseek-chat'


def test_reorder_providers_validates_request_shape(service):
    invalid_payloads = [
        None,
        {},
        {'provider_keys': 'demo_deepseek'},
        {'provider_keys': ['demo_deepseek', '']},
    ]

    for payload in invalid_payloads:
        with pytest.raises(ModelAdapterServiceError) as error:
            service.reorder_providers(payload)
        assert error.value.status_code == 400


def test_reorder_providers_normalizes_keys_and_maps_adapter_errors(monkeypatch):
    adapter = FakeAdapter()
    monkeypatch.setattr('services.model_adapter_service.get_default_adapter', lambda: adapter)
    service = ModelAdapterService()

    result = service.reorder_providers({
        'provider_keys': [' first_deepseek ', 'second_openrouter'],
    })

    assert result == ['first_deepseek', 'second_openrouter']
    assert adapter.reordered_provider_keys == ['first_deepseek', 'second_openrouter']

    adapter.reorder_error = ValueError('未知 Provider: missing_openai')
    with pytest.raises(ModelAdapterServiceError) as error:
        service.reorder_providers({'provider_keys': ['missing_openai']})

    assert error.value.status_code == 400
    assert error.value.message == '未知 Provider: missing_openai'
