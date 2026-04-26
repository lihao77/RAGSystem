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
