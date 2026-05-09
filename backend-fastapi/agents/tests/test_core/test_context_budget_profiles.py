# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.context.budget import (
    ORCHESTRATOR_CONTEXT_PROFILE_NAME,
    WORKER_CONTEXT_PROFILE_NAME,
    compute_context_budget,
    get_context_budget_profile,
)
from agents.core.base import BaseAgent
from agents.core.models import AgentResponse


class _DummyAgent(BaseAgent):
    def execute(self, task, context):
        del task, context
        return AgentResponse(success=True, content="ok")

    def get_llm_config(self, context=None, task_type=None):
        del context, task_type
        return {
            "model_name": "demo-model",
            "max_completion_tokens": 1000,
            "max_context_tokens": None,
        }


def _make_agent(*, behavior=None):
    return _DummyAgent(
        name="demo",
        description="demo",
        model_adapter=object(),
        agent_config=SimpleNamespace(
            custom_params={"behavior": behavior or {}},
            tools=SimpleNamespace(enabled_tools=[]),
        ),
    )


def test_budget_profiles_expose_explicit_agent_defaults():
    worker_profile = get_context_budget_profile(WORKER_CONTEXT_PROFILE_NAME)
    orchestrator_profile = get_context_budget_profile(ORCHESTRATOR_CONTEXT_PROFILE_NAME)

    assert worker_profile.name == WORKER_CONTEXT_PROFILE_NAME
    assert worker_profile.fallback_multiplier == 3
    assert worker_profile.compression_trigger_ratio == 0.85
    assert orchestrator_profile.name == ORCHESTRATOR_CONTEXT_PROFILE_NAME
    assert orchestrator_profile.fallback_multiplier == 3
    assert orchestrator_profile.compression_trigger_ratio == 0.85
    assert orchestrator_profile.summarize_max_tokens == 300
    assert orchestrator_profile.preserve_recent_turns == 3


def test_unknown_budget_profile_falls_back_to_worker():
    profile = get_context_budget_profile("unknown-profile")

    assert profile.name == WORKER_CONTEXT_PROFILE_NAME


def test_setup_react_runtime_uses_profile_defaults():
    agent = _make_agent()

    agent._setup_react_runtime(
        available_tools=[],
        available_skills=[],
        budget_profile_name=ORCHESTRATOR_CONTEXT_PROFILE_NAME,
        runtime_label="DummyAgent",
    )

    assert not hasattr(agent, "max_rounds")
    assert agent.context_pipeline.config.budget_profile == ORCHESTRATOR_CONTEXT_PROFILE_NAME
    assert agent.context_pipeline.config.compression_trigger_ratio == 0.85
    assert agent.context_pipeline.config.summarize_max_tokens == 300
    assert agent.context_pipeline.config.preserve_recent_turns == 3
    assert agent.context_pipeline.config.max_tokens == compute_context_budget(
        model_context_window=None,
        max_completion_tokens=1000,
        fallback_multiplier=3,
    )
    assert agent.observation_policy.budget_profile == ORCHESTRATOR_CONTEXT_PROFILE_NAME
    assert agent.observation_policy.max_context_tokens == agent.context_pipeline.config.max_tokens


def test_worker_and_orchestrator_share_same_context_budget_baseline():
    worker_profile = get_context_budget_profile(WORKER_CONTEXT_PROFILE_NAME)
    orchestrator_profile = get_context_budget_profile(ORCHESTRATOR_CONTEXT_PROFILE_NAME)

    worker_budget = compute_context_budget(
        model_context_window=None,
        max_completion_tokens=1200,
        fallback_multiplier=worker_profile.fallback_multiplier,
    )
    orchestrator_budget = compute_context_budget(
        model_context_window=None,
        max_completion_tokens=1200,
        fallback_multiplier=orchestrator_profile.fallback_multiplier,
    )

    assert orchestrator_budget == worker_budget


def test_setup_react_runtime_allows_behavior_overrides_profile_defaults():
    agent = _make_agent(
        behavior={
            "budget_profile": ORCHESTRATOR_CONTEXT_PROFILE_NAME,
            "rounds": 7,
            "compression_trigger_ratio": 0.9,
            "summarize_max_tokens": 512,
            "preserve_recent_turns": 2,
            "fallback_multiplier": 1.2,
        }
    )

    agent._setup_react_runtime(
        available_tools=[],
        available_skills=[],
        budget_profile_name=WORKER_CONTEXT_PROFILE_NAME,
        runtime_label="DummyAgent",
    )

    assert not hasattr(agent, "max_rounds")
    assert agent.context_pipeline.config.budget_profile == ORCHESTRATOR_CONTEXT_PROFILE_NAME
    assert agent.context_pipeline.config.compression_trigger_ratio == 0.9
    assert agent.context_pipeline.config.summarize_max_tokens == 512
    assert agent.context_pipeline.config.preserve_recent_turns == 2
    assert agent.context_pipeline.config.max_tokens == compute_context_budget(
        model_context_window=None,
        max_completion_tokens=1000,
        fallback_multiplier=1.2,
    )
    assert agent.observation_policy.budget_profile == ORCHESTRATOR_CONTEXT_PROFILE_NAME


def test_setup_react_runtime_allows_observation_policy_overrides():
    agent = _make_agent(
        behavior={
            "observation_inline_text_limit": 321,
            "observation_inline_json_limit": 654,
            "observation_summarize_limit": 987,
            "observation_artifact_ttl_seconds": 222,
        }
    )

    agent._setup_react_runtime(
        available_tools=[],
        available_skills=[],
        runtime_label="DummyAgent",
    )

    assert agent.observation_policy.inline_text_limit == 321
    assert agent.observation_policy.inline_json_limit == 654
    assert agent.observation_policy.summarize_limit == 987
    assert agent.observation_policy.artifact_ttl_seconds == 222


def test_setup_react_runtime_ignores_legacy_round_limits():
    agent = _make_agent(
        behavior={
            "max_rounds": 9,
            "rounds": 7,
        }
    )

    agent._setup_react_runtime(
        available_tools=[],
        available_skills=[],
        runtime_label="DummyAgent",
    )

    assert not hasattr(agent, "max_rounds")
