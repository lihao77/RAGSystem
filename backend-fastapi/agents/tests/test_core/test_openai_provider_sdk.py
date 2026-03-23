# -*- coding: utf-8 -*-

from __future__ import annotations

import importlib.util
import sys
import time
import types
from enum import Enum
from pathlib import Path
from types import SimpleNamespace


def _load_provider_module():
    module_name = 'integrations.model_providers.openai_provider_test'
    module_path = Path(__file__).resolve().parents[3] / 'integrations' / 'model_providers' / 'openai_provider.py'
    missing = object()
    patched_module_names = [
        'integrations',
        'integrations.model_providers',
        'integrations.model_providers.common',
        'model_adapter',
        'model_adapter.base',
        'integrations.model_providers.openai_compatible_provider',
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
        OPENAI = 'openai'

    class _BaseResponse:
        def __init__(self, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)
            self.error = kwargs.get('error')

    class ModelResponse(_BaseResponse):
        pass

    class EmbeddingResponse(_BaseResponse):
        pass

    base_module.AIProviderType = AIProviderType
    base_module.ModelResponse = ModelResponse
    base_module.EmbeddingResponse = EmbeddingResponse
    sys.modules['model_adapter.base'] = base_module

    compat_module = types.ModuleType('integrations.model_providers.openai_compatible_provider')

    class OpenAICompatibleProvider:
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
            self.thinking_budget_tokens = kwargs.get('thinking_budget_tokens')
            self.reasoning_effort = kwargs.get('reasoning_effort')
            self.timeout = kwargs.get('timeout', 30)
            self.supports_function_calling = kwargs.get('supports_function_calling', False)

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

        def _should_attach_tools(self):
            return self.supports_function_calling

        def _default_embedding_model(self):
            return 'text-embedding-3-small'

        def _supports_dimensions(self):
            return True

    compat_module.OpenAICompatibleProvider = OpenAICompatibleProvider
    sys.modules['integrations.model_providers.openai_compatible_provider'] = compat_module

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


class _FakeToolCall:
    def model_dump(self, mode='python', exclude_none=True):
        del mode, exclude_none
        return {
            'id': 'call_1',
            'type': 'function',
            'function': {
                'name': 'demo_tool',
                'arguments': '{"x":1}',
            },
        }


class _FakeChunkStream:
    def __init__(self, chunks):
        self._chunks = list(chunks)
        self.closed = False

    def __iter__(self):
        return iter(self._chunks)

    def close(self):
        self.closed = True


class _FakeChatCompletions:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get('stream'):
            return _FakeChunkStream([
                SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content='<intent>分析</intent>'),
                            finish_reason=None,
                        )
                    ]
                ),
                SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content=''),
                            finish_reason='stop',
                        )
                    ]
                ),
            ])

        return SimpleNamespace(
            model=kwargs['model'],
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content='ok',
                        tool_calls=[_FakeToolCall()],
                    ),
                    finish_reason='stop',
                )
            ],
            usage=SimpleNamespace(
                prompt_tokens=11,
                completion_tokens=7,
                total_tokens=18,
                prompt_tokens_details=SimpleNamespace(cached_tokens=5),
            ),
        )


class _FakeEmbeddings:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            model=kwargs['model'],
            data=[
                SimpleNamespace(index=1, embedding=[0.3, 0.4]),
                SimpleNamespace(index=0, embedding=[0.1, 0.2]),
            ],
            usage=SimpleNamespace(prompt_tokens=5, total_tokens=5),
        )


class _FakeModels:
    def __init__(self):
        self.list_calls = 0

    def list(self):
        self.list_calls += 1
        return [SimpleNamespace(id='gpt-5.4')]


class _FakeClient:
    def __init__(self):
        self.chat = SimpleNamespace(completions=_FakeChatCompletions())
        self.embeddings = _FakeEmbeddings()
        self.models = _FakeModels()


def test_openai_provider_uses_sdk_for_chat_and_preserves_extra_body(monkeypatch):
    fake_client = _FakeClient()
    monkeypatch.setattr(provider_module, 'OpenAI', lambda **kwargs: fake_client)

    provider = provider_module.OpenAIProvider(
        api_key='demo',
        name='OpenAI',
        model='gpt-5.4',
        api_endpoint='https://api.openai.com/v1',
    )

    response = provider.chat_completion(
        messages=[{'role': 'user', 'content': 'hello'}],
        stop=['</tools>'],
        reasoning_effort='high',
        thinking_budget_tokens=2048,
    )

    assert response.error is None
    assert response.content == 'ok'
    assert response.usage['cached_tokens'] == 5
    assert response.tool_calls[0]['function']['name'] == 'demo_tool'

    call = fake_client.chat.completions.calls[0]
    assert call['model'] == 'gpt-5.4'
    assert call['stop'] == ['</tools>']
    assert call['extra_body']['reasoning_effort'] == 'high'
    assert call['extra_body']['thinking_budget_tokens'] == 2048


def test_openai_provider_uses_sdk_for_stream_and_embeddings(monkeypatch):
    fake_client = _FakeClient()
    monkeypatch.setattr(provider_module, 'OpenAI', lambda **kwargs: fake_client)

    provider = provider_module.OpenAIProvider(
        api_key='demo',
        name='OpenAI',
        model='gpt-5.4',
        api_endpoint='https://api.openai.com/v1',
    )

    chunks = list(provider.chat_completion_stream(
        messages=[{'role': 'user', 'content': 'hello'}],
        stop=['</tools>'],
        reasoning_effort='medium',
    ))
    embedding = provider.embed(['a', 'b'], model='text-embedding-3-small', dimensions=256)

    assert chunks[0]['content'] == '<intent>分析</intent>'
    assert chunks[-1]['finish_reason'] == 'stop'
    assert fake_client.chat.completions.calls[0]['stream'] is True
    assert fake_client.chat.completions.calls[0]['extra_body']['reasoning_effort'] == 'medium'

    assert embedding.error is None
    assert embedding.embeddings == [[0.1, 0.2], [0.3, 0.4]]
    assert fake_client.embeddings.calls[0]['dimensions'] == 256
    assert provider.is_available() is True
