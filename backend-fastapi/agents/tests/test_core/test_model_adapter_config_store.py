# -*- coding: utf-8 -*-

from __future__ import annotations

import yaml

from model_adapter.config_store import ModelAdapterConfigStore


def test_load_all_normalizes_legacy_openai_provider_keys(tmp_path):
    config_file = tmp_path / 'providers.yaml'
    config_file.write_text(
        yaml.safe_dump(
            {
                'demo_openai_responses': {
                    'name': 'demo',
                    'provider_type': 'openai_responses',
                    'api_key': 'key',
                    'model_map': {'chat': 'gpt-5.4'},
                },
                'proxy_openai_compatible_chat': {
                    'name': 'proxy',
                    'provider_type': 'openai_compatible_chat',
                    'api_key': 'key',
                    'model_map': {'chat': 'gpt-5.4'},
                },
            },
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding='utf-8',
    )

    store = ModelAdapterConfigStore(config_file)

    configs = store.load_all()

    assert set(configs) == {'demo_openai_resp', 'proxy_openai_proxy'}
    assert configs['demo_openai_resp']['provider_type'] == 'openai_resp'
    assert configs['proxy_openai_proxy']['provider_type'] == 'openai_proxy'

    persisted = yaml.safe_load(config_file.read_text(encoding='utf-8'))
    assert set(persisted) == {'demo_openai_resp', 'proxy_openai_proxy'}


def test_save_provider_preserves_existing_providers_and_normalizes_model_map(tmp_path):
    config_file = tmp_path / 'providers.yaml'
    config_file.write_text(
        yaml.safe_dump(
            {
                'existing_deepseek': {
                    'name': 'existing',
                    'provider_type': 'deepseek',
                    'api_key': 'key',
                    'model_map': {'chat': 'deepseek-chat'},
                },
            },
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding='utf-8',
    )

    store = ModelAdapterConfigStore(config_file)
    store.save_provider(
        'demo_openai_chat',
        {
            'name': 'demo',
            'provider_type': 'openai_chat',
            'api_key': 'key',
            'model_map': {
                'chat': ['gpt-4.1', 'gpt-4.1', 'gpt-4o'],
                'embedding': 'text-embedding-3-small',
                'empty': [],
            },
        },
    )

    persisted = yaml.safe_load(config_file.read_text(encoding='utf-8'))

    assert set(persisted) == {'existing_deepseek', 'demo_openai_chat'}
    assert persisted['existing_deepseek']['models'] == ['deepseek-chat']
    assert persisted['demo_openai_chat']['model_map'] == {
        'chat': ['gpt-4.1', 'gpt-4o'],
        'embedding': 'text-embedding-3-small',
    }
    assert persisted['demo_openai_chat']['models'] == [
        'gpt-4.1',
        'gpt-4o',
        'text-embedding-3-small',
    ]


def test_load_all_keeps_legacy_models_when_model_map_missing(tmp_path):
    config_file = tmp_path / 'providers.yaml'
    config_file.write_text(
        yaml.safe_dump(
            {
                'legacy_deepseek': {
                    'name': 'legacy',
                    'provider_type': 'deepseek',
                    'api_key': 'key',
                    'models': ['deepseek-chat', 'deepseek-reasoner'],
                },
                'single_deepseek': {
                    'name': 'single',
                    'provider_type': 'deepseek',
                    'api_key': 'key',
                    'model': 'deepseek-chat',
                },
            },
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding='utf-8',
    )

    configs = ModelAdapterConfigStore(config_file).load_all()

    assert configs['legacy_deepseek']['model_map'] == {
        'chat': ['deepseek-chat', 'deepseek-reasoner'],
    }
    assert configs['legacy_deepseek']['models'] == ['deepseek-chat', 'deepseek-reasoner']
    assert configs['single_deepseek']['model_map'] == {'chat': 'deepseek-chat'}
    assert configs['single_deepseek']['models'] == ['deepseek-chat']


def test_save_provider_appends_new_key_and_update_keeps_position(tmp_path):
    config_file = tmp_path / 'providers.yaml'
    config_file.write_text(
        yaml.safe_dump(
            {
                'first_deepseek': {
                    'name': 'first',
                    'provider_type': 'deepseek',
                    'api_key': 'key',
                    'model_map': {'chat': 'deepseek-chat'},
                },
                'second_openrouter': {
                    'name': 'second',
                    'provider_type': 'openrouter',
                    'api_key': 'key',
                    'model_map': {'chat': 'openai/gpt-4o'},
                },
            },
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding='utf-8',
    )

    store = ModelAdapterConfigStore(config_file)
    store.save_provider(
        'third_modelscope',
        {
            'name': 'third',
            'provider_type': 'modelscope',
            'api_key': 'key',
            'model_map': {'chat': 'qwen-plus'},
        },
    )
    store.save_provider(
        'second_openrouter',
        {
            'name': 'second',
            'provider_type': 'openrouter',
            'api_key': 'key',
            'model_map': {'chat': 'openai/gpt-4.1'},
        },
    )

    persisted = yaml.safe_load(config_file.read_text(encoding='utf-8'))

    assert list(persisted) == ['first_deepseek', 'second_openrouter', 'third_modelscope']
    assert persisted['second_openrouter']['models'] == ['openai/gpt-4.1']


def test_reorder_providers_persists_order_and_rejects_invalid_keys(tmp_path):
    config_file = tmp_path / 'providers.yaml'
    config_file.write_text(
        yaml.safe_dump(
            {
                'first_deepseek': {
                    'name': 'first',
                    'provider_type': 'deepseek',
                    'api_key': 'key',
                    'model_map': {'chat': 'deepseek-chat'},
                },
                'second_openrouter': {
                    'name': 'second',
                    'provider_type': 'openrouter',
                    'api_key': 'key',
                    'model_map': {'chat': 'openai/gpt-4o'},
                },
                'third_modelscope': {
                    'name': 'third',
                    'provider_type': 'modelscope',
                    'api_key': 'key',
                    'model_map': {'chat': 'qwen-plus'},
                },
            },
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding='utf-8',
    )

    store = ModelAdapterConfigStore(config_file)
    reordered = store.reorder_providers([
        'third_modelscope',
        'first_deepseek',
        'second_openrouter',
    ])
    persisted = yaml.safe_load(config_file.read_text(encoding='utf-8'))

    assert list(reordered) == ['third_modelscope', 'first_deepseek', 'second_openrouter']
    assert list(persisted) == ['third_modelscope', 'first_deepseek', 'second_openrouter']

    invalid_orders = [
        ['third_modelscope', 'third_modelscope', 'second_openrouter'],
        ['third_modelscope', 'first_deepseek'],
        ['third_modelscope', 'first_deepseek', 'unknown_openai'],
    ]
    for provider_keys in invalid_orders:
        try:
            store.reorder_providers(provider_keys)
        except ValueError:
            pass
        else:
            raise AssertionError('invalid provider order should be rejected')

