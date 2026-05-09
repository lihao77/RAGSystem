# -*- coding: utf-8 -*-

from types import SimpleNamespace

import pytest

from agents.config.models import AgentLLMConfig, AgentConfig
from agents.core.base import BaseAgent
from agents.core.context import AgentContext
from agents.core.models import AgentResponse
from agents.streaming.stream_executor import StreamExecutor
from model_adapter import ModelAdapter
from model_adapter.base import AIProvider, AIProviderType, EmbeddingResponse, ModelResponse


class _DummyAgent(BaseAgent):
    def execute(self, task, context):
        del task, context
        return AgentResponse(success=True, content="ok")


class _CaptureAdapter:
    def __init__(self):
        self.last_call = None

    def chat_completion_stream(self, **kwargs):
        self.last_call = kwargs
        yield {"content": "<answer>ok</answer>", "finish_reason": "stop"}


class _CaptureProvider(AIProvider):
    def __init__(self):
        super().__init__(
            name="Demo",
            api_key="demo",
            api_endpoint="https://example.com",
            model="demo-model",
            retry_attempts=1,
        )
        self.last_call = None
        self.last_stream_call = None

    def _do_chat_completion(self, messages, model=None, temperature=None, max_tokens=None, tools=None, tool_choice=None, **kwargs):
        del messages, model, temperature, max_tokens, tools, tool_choice
        self.last_call = kwargs
        return ModelResponse(content="ok", provider=self.name)

    def chat_completion_stream(self, messages, model=None, temperature=None, max_tokens=None, **kwargs):
        del messages, model, temperature, max_tokens
        self.last_stream_call = kwargs
        yield {"content": "ok", "finish_reason": "stop"}

    def generate_text(self, prompt, model=None, temperature=None, max_tokens=None, **kwargs):
        del prompt, model, temperature, max_tokens, kwargs
        return ModelResponse(content="ok", provider=self.name)

    def embed(self, texts, model=None, dimensions=None, **kwargs):
        del texts, model, dimensions, kwargs
        return EmbeddingResponse(embeddings=[], provider=self.name)

    def _get_provider_type(self):
        return AIProviderType.CUSTOM

    def get_model_list(self):
        return ["demo-model"]

    def calculate_cost(self, input_tokens, output_tokens, model):
        del input_tokens, output_tokens, model
        return 0.0

    def is_available(self):
        return True


def test_agent_config_rejects_invalid_llm_tier_keys():
    with pytest.raises(ValueError, match='llm_tiers 仅支持 fast/default/powerful'):
        AgentConfig(
            agent_name='demo',
            llm=AgentLLMConfig(),
            llm_tiers={'summary': AgentLLMConfig(model_name='demo-model')},
        )


def test_base_agent_uses_internal_task_type_then_falls_back_to_default_tier():
    agent = _DummyAgent(
        name='demo',
        description='demo',
        model_adapter=None,
        agent_config=AgentConfig(
            agent_name='demo',
            llm=AgentLLMConfig(model_name='base-model'),
            llm_tiers={
                'default': AgentLLMConfig(model_name='default-model'),
                'fast': AgentLLMConfig(model_name='fast-model'),
            },
        ),
        system_config=None,
    )
    context = AgentContext(session_id='s1')

    config = agent.get_llm_config(context, task_type='powerful')

    assert config['model_name'] == 'default-model'


def test_base_agent_falls_back_to_system_llm_when_tiers_missing():
    agent = _DummyAgent(
        name='demo',
        description='demo',
        model_adapter=None,
        agent_config=AgentConfig(agent_name='demo', llm_tiers={}),
        system_config=SimpleNamespace(
            llm=SimpleNamespace(
                provider='system',
                provider_type='custom',
                model_name='system-model',
            )
        ),
    )

    config = agent.get_llm_config(task_type='fast')

    assert config['provider'] == 'system'
    assert config['model_name'] == 'system-model'


def test_base_agent_tier_config_merges_missing_identity_from_system_llm():
    agent = _DummyAgent(
        name='demo',
        description='demo',
        model_adapter=None,
        agent_config=AgentConfig(
            agent_name='demo',
            llm_tiers={
                'fast': AgentLLMConfig(model_name='fast-model'),
            },
        ),
        system_config=SimpleNamespace(
            llm=SimpleNamespace(
                provider='system',
                provider_type='custom',
                model_name='system-model',
            )
        ),
    )

    config = agent.get_llm_config(task_type='fast')

    assert config['model_name'] == 'fast-model'
    assert config['provider'] == 'system'


def test_base_agent_selected_llm_overrides_model_identity_only():
    agent = _DummyAgent(
        name='demo',
        description='demo',
        model_adapter=None,
        agent_config=AgentConfig(
            agent_name='demo',
            llm=AgentLLMConfig(model_name='base-model', temperature=0.2, extra_params={'thinking_budget_tokens': 1024}),
            llm_tiers={
                'default': AgentLLMConfig(model_name='tier-model', temperature=0.1, extra_params={'reasoning_effort': 'medium'}),
            },
        ),
        system_config=None,
    )
    context = AgentContext(
        session_id='s1',
        llm_override={'provider': 'demo', 'provider_type': 'custom', 'model_name': 'override-model'},
    )

    config = agent.get_llm_config(context, task_type='default')

    assert config['provider'] == 'demo'
    assert config['provider_type'] == 'custom'
    assert config['model_name'] == 'override-model'
    assert config['temperature'] == 0.1
    assert config['reasoning_effort'] == 'medium'


def test_agent_llm_config_merges_extra_params_and_protects_base_fields():
    default_config = SimpleNamespace(
        llm=SimpleNamespace(
            provider='demo',
            provider_type='custom',
            model_name='demo-model',
            temperature=0.3,
            max_completion_tokens=4096,
            max_context_tokens=128000,
            extra_params={
                'top_p': 0.8,
                'thinking_budget_tokens': 2048,
                'temperature': 999,
            },
        )
    )
    config = AgentLLMConfig(
        temperature=0.2,
        extra_params={
            'thinking_budget_tokens': 4096,
            'reasoning_effort': 'high',
            'top_p': 0.2,
        },
    )

    merged = config.merge_with_default(default_config=default_config)

    assert merged['temperature'] == 0.2
    assert merged['top_p'] == 0.2  # config 的 extra_params 覆盖 default
    assert merged['thinking_budget_tokens'] == 4096
    assert merged['reasoning_effort'] == 'high'


def test_base_agent_system_default_llm_keeps_extra_params():
    agent = _DummyAgent(
        name="demo",
        description="demo",
        model_adapter=None,
        agent_config=None,
        system_config=SimpleNamespace(
            llm=SimpleNamespace(
                provider="demo",
                provider_type="deepseek",
                model_name="demo-model",
                temperature=0.2,
                max_completion_tokens=3072,
                max_context_tokens=64000,
                extra_params={
                    'thinking_budget_tokens': 4096,
                    'reasoning_effort': 'high',
                },
            )
        ),
    )

    config = agent.get_llm_config()

    assert config["max_completion_tokens"] == 3072
    assert config["thinking_budget_tokens"] == 4096
    assert config["reasoning_effort"] == "high"


def test_stream_executor_passes_extra_params_to_model_adapter():
    adapter = _CaptureAdapter()
    executor = StreamExecutor(model_adapter=adapter, publisher=None)

    result = executor.execute_llm_stream(
        messages=[{"role": "user", "content": "hello"}],
        llm_config={
            "provider": "demo",
            "provider_type": "deepseek",
            "model_name": "demo-model",
            "max_completion_tokens": 512,
            "thinking_budget_tokens": 4096,
            "reasoning_effort": "medium",
        },
        round_num=1,
    )

    assert result.answer == "ok"
    assert adapter.last_call["max_tokens"] == 512
    assert adapter.last_call["thinking_budget_tokens"] == 4096
    assert adapter.last_call["reasoning_effort"] == "medium"


def test_model_adapter_passes_extra_kwargs_to_provider():
    adapter = ModelAdapter()
    provider = _CaptureProvider()
    adapter.providers = {"demo_custom": provider}

    response = adapter.chat_completion(
        messages=[{"role": "user", "content": "hello"}],
        provider="demo",
        provider_type="custom",
        thinking_budget_tokens=2048,
        reasoning_effort="low",
    )

    assert response.error is None
    assert provider.last_call["thinking_budget_tokens"] == 2048
    assert provider.last_call["reasoning_effort"] == "low"

    list(adapter.chat_completion_stream(
        messages=[{"role": "user", "content": "hello"}],
        provider="demo",
        provider_type="custom",
        thinking_budget_tokens=1024,
        reasoning_effort="high",
    ))

    assert provider.last_stream_call["thinking_budget_tokens"] == 1024
    assert provider.last_stream_call["reasoning_effort"] == "high"
