# -*- coding: utf-8 -*-

from __future__ import annotations

import importlib.util
import sys
import types
from enum import Enum
from pathlib import Path



def _load_factory_module():
    module_name = 'integrations.model_providers.factory_test'
    module_path = Path(__file__).resolve().parents[3] / 'integrations' / 'model_providers' / 'factory.py'
    missing = object()
    patched_module_names = [
        'integrations',
        'integrations.model_providers',
        'integrations.model_providers.providers_impl',
    ]
    originals = {name: sys.modules.get(name, missing) for name in patched_module_names}

    integrations_pkg = types.ModuleType('integrations')
    integrations_pkg.__path__ = [str(module_path.parents[1])]
    sys.modules['integrations'] = integrations_pkg

    providers_pkg = types.ModuleType('integrations.model_providers')
    providers_pkg.__path__ = [str(module_path.parent)]
    sys.modules['integrations.model_providers'] = providers_pkg

    providers_impl_module = types.ModuleType('integrations.model_providers.providers_impl')

    class _ProviderBase:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class OpenAIProvider(_ProviderBase):
        pass

    class OpenAIChatCompletionsProvider(_ProviderBase):
        pass

    class OpenAIResponsesProvider(_ProviderBase):
        pass

    class OpenAICompatibleProvider(_ProviderBase):
        pass

    class AnthropicProvider(_ProviderBase):
        pass

    class DeepSeekProvider(_ProviderBase):
        pass

    class OpenRouterProvider(_ProviderBase):
        pass

    class ModelScopeProvider(_ProviderBase):
        pass

    providers_impl_module.OpenAIProvider = OpenAIProvider
    providers_impl_module.OpenAIChatCompletionsProvider = OpenAIChatCompletionsProvider
    providers_impl_module.OpenAIResponsesProvider = OpenAIResponsesProvider
    providers_impl_module.OpenAICompatibleProvider = OpenAICompatibleProvider
    providers_impl_module.AnthropicProvider = AnthropicProvider
    providers_impl_module.DeepSeekProvider = DeepSeekProvider
    providers_impl_module.OpenRouterProvider = OpenRouterProvider
    providers_impl_module.ModelScopeProvider = ModelScopeProvider
    sys.modules['integrations.model_providers.providers_impl'] = providers_impl_module

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


factory_module = _load_factory_module()



def test_canonicalize_openai_provider_type_defaults_to_chat_completions():
    assert factory_module.canonicalize_provider_type('openai') == 'openai_chat_completions'



def test_canonicalize_openai_provider_type_supports_responses_mode():
    assert factory_module.canonicalize_provider_type('openai', 'responses') == 'openai_responses'



def test_create_provider_from_config_uses_chat_completions_provider_for_legacy_openai():
    provider = factory_module.create_provider_from_config({
        'name': 'demo',
        'provider_type': 'openai',
        'api_key': 'key',
        'model': 'gpt-5.4',
    })
    assert provider.__class__.__name__ == 'OpenAIChatCompletionsProvider'
    assert provider.kwargs['api_endpoint'] == 'https://api.openai.com/v1'



def test_create_provider_from_config_uses_responses_provider_when_requested():
    provider = factory_module.create_provider_from_config({
        'name': 'demo',
        'provider_type': 'openai',
        'api_mode': 'responses',
        'api_key': 'key',
        'model': 'gpt-5.4',
    })
    assert provider.__class__.__name__ == 'OpenAIResponsesProvider'



def test_create_provider_from_config_uses_openai_compatible_chat_provider():
    provider = factory_module.create_provider_from_config({
        'name': 'proxy',
        'provider_type': 'openai_compatible_chat',
        'api_key': 'key',
        'model': 'gpt-5.4',
    })
    assert provider.__class__.__name__ == 'OpenAICompatibleProvider'
