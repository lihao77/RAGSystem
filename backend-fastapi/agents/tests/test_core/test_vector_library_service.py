# -*- coding: utf-8 -*-

from __future__ import annotations

import pytest

from services.vector_library_service import VectorLibraryService, VectorLibraryServiceError


class FakeProviderConfigStore:
    def __init__(self, configs):
        self.configs = configs

    def load_all(self):
        return self.configs


class FakeVectorizerStore:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.active_key = None

    def list_vectorizers(self):
        return self.rows

    def get_vectorizer(self, key):
        for row in self.rows:
            if row.get('vectorizer_key') == key:
                return row
        return None

    def set_active_key(self, key):
        self.active_key = key


class FakeModelManager:
    def get_model_by_vectorizer_key(self, key):
        return None


def test_add_vectorizer_rejects_missing_provider_before_writing():
    service = VectorLibraryService(
        vectorizer_store=FakeVectorizerStore(),
        provider_config_store=FakeProviderConfigStore({}),
        embedder_factory=lambda key: object(),
    )

    with pytest.raises(VectorLibraryServiceError) as error:
        service.add_vectorizer({
            'provider_key': 'missing_openrouter',
            'model_name': 'openai/text-embedding-3-small',
        })

    assert error.value.status_code == 400
    assert 'Provider 不存在' in error.value.message


def test_list_vectorizers_marks_missing_provider():
    service = VectorLibraryService(
        vectorizer_store=FakeVectorizerStore([
            {
                'vectorizer_key': 'known_text-embedding-3-small',
                'provider_key': 'known_openai_chat',
                'provider_type': None,
                'model_name': 'text-embedding-3-small',
                'distance_metric': 'cosine',
                'created_at': None,
                'is_active': True,
            },
            {
                'vectorizer_key': 'missing_text-embedding-3-small',
                'provider_key': 'missing_openai_chat',
                'provider_type': None,
                'model_name': 'text-embedding-3-small',
                'distance_metric': 'cosine',
                'created_at': None,
                'is_active': False,
            },
        ]),
        provider_config_store=FakeProviderConfigStore({
            'known_openai_chat': {
                'name': 'known',
                'provider_type': 'openai_chat',
                'api_key': 'key',
            },
        }),
        model_manager=FakeModelManager(),
    )

    rows = service.list_vectorizers()

    assert rows[0]['provider_available'] is True
    assert rows[1]['provider_available'] is False


def test_activate_vectorizer_rejects_missing_provider():
    store = FakeVectorizerStore([
        {
            'vectorizer_key': 'missing_text-embedding-3-small',
            'provider_key': 'missing_openai_chat',
            'provider_type': None,
            'model_name': 'text-embedding-3-small',
            'distance_metric': 'cosine',
            'created_at': None,
            'is_active': False,
        },
    ])
    service = VectorLibraryService(
        vectorizer_store=store,
        provider_config_store=FakeProviderConfigStore({}),
        model_manager=FakeModelManager(),
    )

    with pytest.raises(VectorLibraryServiceError) as error:
        service.activate_vectorizer('missing_text-embedding-3-small')

    assert error.value.status_code == 400
    assert store.active_key is None
