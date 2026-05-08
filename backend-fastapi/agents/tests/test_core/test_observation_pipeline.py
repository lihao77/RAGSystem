# -*- coding: utf-8 -*-

import shutil
import tempfile
from pathlib import Path

from agents.artifacts import ArtifactStore
from agents.context.observation_policy import ObservationPolicy
from agents.context.prompt_materializer import PromptMaterializer
from tools.runtime.result_normalizer import ToolResultNormalizer
from tools.runtime.response_builder import success_result


def _make_workspace_tmp_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="obs_pipeline_", dir=Path(__file__).parent))


def test_observation_pipeline_inline_text_output():
    tmp_dir = _make_workspace_tmp_dir()
    store = ArtifactStore(base_dir=str(tmp_dir / "temp_data"))
    normalizer = ToolResultNormalizer()
    policy = ObservationPolicy(
        max_context_tokens=8000,
        inline_text_limit=100,
        inline_json_limit=100,
        summarize_limit=200,
    )
    materializer = PromptMaterializer(
        artifact_store=store,
        large_data_threshold=policy.large_data_threshold,
    )
    result = success_result("hello", summary="读取成功", tool_name="read_file")

    try:
        normalized = normalizer.normalize(result, tool_name="read_file")
        decision = policy.decide(normalized)
        observation = materializer.materialize_tool_observation(
            normalized,
            decision,
            tool_name="read_file",
        )

        assert observation == "读取成功\n\nhello"
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_observation_pipeline_uses_artifact_for_large_payload():
    tmp_dir = _make_workspace_tmp_dir()
    store = ArtifactStore(base_dir=str(tmp_dir / "temp_data"))
    normalizer = ToolResultNormalizer()
    policy = ObservationPolicy(
        max_context_tokens=8000,
        inline_text_limit=50,
        inline_json_limit=50,
        summarize_limit=100,
        artifact_ttl_seconds=600,
    )
    materializer = PromptMaterializer(
        artifact_store=store,
        large_data_threshold=policy.large_data_threshold,
    )
    result = success_result(
        [{"value": "x" * 9000}],
        summary="数据过大",
        tool_name="preview_data_structure",
        output_type="json",
    )

    try:
        normalized = normalizer.normalize(result, tool_name="preview_data_structure")
        decision = policy.decide(normalized)
        observation = materializer.materialize_tool_observation(
            normalized,
            decision,
            tool_name="preview_data_structure",
            session_id="session-1",
        )

        assert "数据已存储:" in observation
        assert normalized.artifacts[0].metadata["session_id"] == "session-1"
        assert "expires_at" in normalized.artifacts[0].metadata
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_observation_pipeline_keeps_medium_json_inline():
    tmp_dir = _make_workspace_tmp_dir()
    store = ArtifactStore(base_dir=str(tmp_dir / "temp_data"))
    normalizer = ToolResultNormalizer()
    policy = ObservationPolicy(
        max_context_tokens=8000,
        inline_text_limit=50,
        inline_json_limit=50,
        summarize_limit=200,
    )
    materializer = PromptMaterializer(
        artifact_store=store,
        large_data_threshold=policy.large_data_threshold,
    )
    result = success_result(
        {"artifact_id": "viz_demo123", "viz_type": "map", "title": "示例地图"},
        summary="地图已生成",
        tool_name="create_map",
        output_type="map",
    )

    try:
        normalized = normalizer.normalize(result, tool_name="create_map")
        decision = policy.decide(normalized)
        observation = materializer.materialize_tool_observation(
            normalized,
            decision,
            tool_name="create_map",
        )

        assert decision.mode == "inline"
        # MapObservationFormatter 输出结构化文本
        assert "viz_demo123" in observation
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
