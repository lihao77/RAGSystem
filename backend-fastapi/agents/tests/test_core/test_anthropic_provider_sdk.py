# -*- coding: utf-8 -*-

from __future__ import annotations

import importlib.util
import shutil
import tempfile
import sys
import time
import types
from enum import Enum
from pathlib import Path
from types import SimpleNamespace


def _load_provider_module():
    module_name = 'integrations.model_providers.anthropic_provider_test'
    module_path = Path(__file__).resolve().parents[3] / 'integrations' / 'model_providers' / 'anthropic_provider.py'
    missing = object()
    patched_module_names = [
        'integrations',
        'integrations.model_providers',
        'integrations.model_providers.common',
        'model_adapter',
        'model_adapter.base',
    ]
    originals = {name: sys.modules.get(name, missing) for name in patched_module_names}

    integrations_pkg = types.ModuleType('integrations')
    integrations_pkg.__path__ = [str(module_path.parents[1])]
    sys.modules['integrations'] = integrations_pkg

    providers_pkg = types.ModuleType('integrations.model_providers')
    providers_pkg.__path__ = [str(module_path.parent)]
    sys.modules['integrations.model_providers'] = providers_pkg

    common_module = types.ModuleType('integrations.model_providers.common')

    class InterruptedError(Exception):
        pass

    common_module.InterruptedError = InterruptedError
    sys.modules['integrations.model_providers.common'] = common_module

    model_adapter_pkg = types.ModuleType('model_adapter')
    model_adapter_pkg.__path__ = []
    sys.modules['model_adapter'] = model_adapter_pkg

    base_module = types.ModuleType('model_adapter.base')

    class AIProviderType(str, Enum):
        ANTHROPIC = 'anthropic'

    class _BaseResponse:
        def __init__(self, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)
            self.error = kwargs.get('error')

    class ModelResponse(_BaseResponse):
        pass

    class EmbeddingResponse(_BaseResponse):
        pass

    class AIProvider:
        def __init__(self, name, api_key, api_endpoint, model='', **kwargs):
            self.name = name
            self.api_key = api_key
            self.api_endpoint = api_endpoint.rstrip('/')
            self.model = model
            self.model_map = kwargs.get('model_map', {}) or {}
            if self.model and 'chat' not in self.model_map:
                self.model_map['chat'] = self.model
            self.temperature = kwargs.get('temperature', 0.7)
            self.max_tokens = kwargs.get('max_tokens', 4096)
            self.max_completion_tokens = kwargs.get('max_completion_tokens') or self.max_tokens
            self.timeout = kwargs.get('timeout', 30)
            self.supports_function_calling = kwargs.get('supports_function_calling', False)
            self.supports_prompt_caching = kwargs.get('supports_prompt_caching', False)
            self.prompt_cache_style = kwargs.get('prompt_cache_style')
            self.prompt_cache_min_tokens = kwargs.get('prompt_cache_min_tokens')

        def chat_completion(self, messages, model=None, temperature=None, max_tokens=None, tools=None, tool_choice=None, **kwargs):
            return self._do_chat_completion(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                **kwargs,
            )

        def chat_completion_stream(self, messages, model=None, temperature=None, max_tokens=None, **kwargs):
            yield from self._do_chat_completion_stream(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                **kwargs,
            )

        def get_model_for_task(self, task):
            del task
            return self.model_map.get('chat') or self.model

        def _before_request(self):
            return time.time()

        def _after_request(self, start_time):
            return time.time() - start_time

    base_module.AIProviderType = AIProviderType
    base_module.AIProvider = AIProvider
    base_module.ModelResponse = ModelResponse
    base_module.EmbeddingResponse = EmbeddingResponse
    sys.modules['model_adapter.base'] = base_module

    try:
        spec = importlib.util.spec_from_file_location(module_name, module_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        assert spec.loader is not None
        spec.loader.exec_module(module)
        return module
    finally:
        for name, original in originals.items():
            if original is missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original


provider_module = _load_provider_module()


class _FakeMessages:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            model=kwargs['model'],
            stop_reason='end_turn',
            content=[SimpleNamespace(text='ok')],
            usage=SimpleNamespace(
                input_tokens=120,
                output_tokens=30,
                cache_creation_input_tokens=80,
                cache_read_input_tokens=40,
            ),
        )


class _FakeClient:
    def __init__(self):
        self.messages = _FakeMessages()


def test_anthropic_provider_builds_cache_control_blocks_and_parses_usage(monkeypatch):
    fake_client = _FakeClient()
    monkeypatch.setattr(provider_module, 'Anthropic', lambda **kwargs: fake_client)

    provider = provider_module.AnthropicProvider(
        api_key='demo',
        name='Anthropic',
        model='claude-sonnet-4-5',
        api_endpoint='https://api.anthropic.com',
    )

    response = provider.chat_completion(
        messages=[
            {
                'role': 'system',
                'content': 'stable rules',
                'metadata': {'prompt_cache': {'enabled': True}},
            },
            {
                'role': 'user',
                'content': 'historic summary',
                'metadata': {'prompt_cache': {'enabled': True}, 'compression': True},
                'seq': 8,
            },
            {
                'role': 'user',
                'content': 'current question',
                'metadata': {},
            },
        ],
        stop=['</tools>'],
    )

    assert response.error is None
    assert response.content == 'ok'
    assert response.usage['cache_creation_input_tokens'] == 80
    assert response.usage['cache_read_input_tokens'] == 40

    call = fake_client.messages.calls[0]
    assert call['system'][-1]['cache_control'] == {'type': 'ephemeral'}
    assert call['messages'][0]['content'][-1]['cache_control'] == {'type': 'ephemeral'}
    assert 'cache_control' not in call['messages'][-1]['content'][-1]
    assert call['stop_sequences'] == ['</tools>']


def test_anthropic_provider_only_inlines_image_attachments(monkeypatch):
    fake_client = _FakeClient()
    monkeypatch.setattr(provider_module, 'Anthropic', lambda **kwargs: fake_client)

    temp_dir = Path(tempfile.mkdtemp(dir=Path(__file__).resolve().parent))
    try:
        image_path = temp_dir / 'demo.png'
        image_path.write_bytes(b'png-bytes')
        text_path = temp_dir / 'notes.txt'
        text_path.write_text('hello file', encoding='utf-8')

        provider = provider_module.AnthropicProvider(
            api_key='demo',
            name='Anthropic',
            model='claude-sonnet-4-5',
            api_endpoint='https://api.anthropic.com',
        )

        provider.chat_completion(
            messages=[
                {
                    'role': 'user',
                    'content': 'check attachments',
                    'metadata': {
                        'attachments': [
                            {
                                'file_id': 'img-1',
                                'mime': 'image/png',
                                'stored_path': str(image_path),
                                'kind': 'image',
                            },
                            {
                                'file_id': 'file-1',
                                'mime': 'text/plain',
                                'stored_path': str(text_path),
                                'kind': 'file',
                            },
                        ]
                    },
                }
            ],
        )

        payload = fake_client.messages.calls[-1]
        assert payload['messages'][0]['content'][0] == {'type': 'text', 'text': 'check attachments'}
        assert payload['messages'][0]['content'][1]['type'] == 'image'
        assert len(payload['messages'][0]['content']) == 2
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
