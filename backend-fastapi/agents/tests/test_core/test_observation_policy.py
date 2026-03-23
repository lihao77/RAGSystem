# -*- coding: utf-8 -*-

from agents.context.observation_policy import ObservationPolicy
from tools.response_builder import error_result, success_result


def test_small_text_result_stays_inline():
    policy = ObservationPolicy(
        max_context_tokens=8000,
        inline_text_limit=100,
        inline_json_limit=100,
        summarize_limit=200,
    )
    result = success_result("short text", tool_name="read_file")

    decision = policy.decide(result)

    assert decision.mode == "inline"
    assert decision.reason == "read_file_inline"


def test_medium_json_result_uses_artifact_bucket():
    policy = ObservationPolicy(
        max_context_tokens=8000,
        inline_text_limit=50,
        inline_json_limit=50,
        summarize_limit=300,
    )
    result = success_result(
        [{"value": "x" * 80}],
        tool_name="preview_data_structure",
        output_type="json",
    )

    decision = policy.decide(result)

    assert decision.mode == "artifact_ref"
    assert decision.reason == "large_payload"


def test_large_json_result_uses_artifact_ref():
    policy = ObservationPolicy(
        max_context_tokens=8000,
        inline_text_limit=50,
        inline_json_limit=50,
        summarize_limit=100,
        artifact_ttl_seconds=1234,
    )
    result = success_result(
        [{"value": "x" * 200}],
        tool_name="preview_data_structure",
        output_type="json",
    )

    decision = policy.decide(result)

    assert decision.mode == "artifact_ref"
    assert decision.reason == "large_payload"
    assert decision.artifact_ttl_seconds == 1234


def test_skills_script_follows_size_check():
    """大 skills 脚本输出走 artifact_ref，文档类工具才豁免。"""
    policy = ObservationPolicy(
        max_context_tokens=8000,
        inline_text_limit=50,
        inline_json_limit=50,
        summarize_limit=100,
    )
    result = success_result(
        "x" * 500,
        tool_name="execute_skill_script",
        output_type="text",
    )

    decision = policy.decide(result, is_skills_tool=True)

    assert decision.mode == "artifact_ref"
    assert decision.reason == "large_payload"


def test_small_skills_stays_inline():
    """Skills 文档类工具始终 inline。"""
    policy = ObservationPolicy(
        max_context_tokens=8000,
        inline_text_limit=100,
        inline_json_limit=100,
        summarize_limit=200,
    )
    result = success_result(
        "short skill output",
        tool_name="activate_skill",
        output_type="markdown",
    )

    decision = policy.decide(result, is_skills_tool=True)

    assert decision.mode == "inline"
    assert decision.reason == "skills_inline"


def test_force_artifact():
    """metadata 中 force_artifact 强制落盘。"""
    policy = ObservationPolicy(max_context_tokens=8000)
    result = success_result(
        "small",
        tool_name="some_tool",
        metadata={"force_artifact": True},
    )

    decision = policy.decide(result)

    assert decision.mode == "artifact_ref"
    assert decision.reason == "force_artifact"


def test_error_result_stays_inline():
    policy = ObservationPolicy(max_context_tokens=8000)
    result = error_result("boom", tool_name="read_file")

    decision = policy.decide(result)

    assert decision.mode == "inline"
    assert decision.reason == "error_inline"


def test_orchestrator_profile_is_more_conservative_only_in_observation_materialization():
    worker_policy = ObservationPolicy(max_context_tokens=32000, budget_profile="worker")
    orchestrator_policy = ObservationPolicy(max_context_tokens=32000, budget_profile="orchestrator")

    assert orchestrator_policy.inline_text_limit < worker_policy.inline_text_limit
    assert orchestrator_policy.summarize_limit < worker_policy.summarize_limit
    assert orchestrator_policy.artifact_ttl_seconds < worker_policy.artifact_ttl_seconds
