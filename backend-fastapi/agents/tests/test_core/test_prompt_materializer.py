# -*- coding: utf-8 -*-

import json
import shutil
import tempfile
from pathlib import Path

from agents.artifacts import ArtifactStore
from agents.context.observation_policy import ObservationDecision
from agents.context.prompt_materializer import PromptMaterializer
from tools.runtime.response_builder import success_result


def _make_workspace_tmp_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="obs_materializer_", dir=Path(__file__).parent))


def test_inline_text_output():
    tmp_dir = _make_workspace_tmp_dir()
    store = ArtifactStore(base_dir=str(tmp_dir / "temp_data"))
    materializer = PromptMaterializer(artifact_store=store, large_data_threshold=50)
    result = success_result("hello", summary="读取成功", tool_name="read_file")

    try:
        observation = materializer.materialize_tool_observation(
            result,
            ObservationDecision(mode="inline"),
            tool_name="read_file",
        )

        assert observation == "读取成功\n\nhello"
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_summarize_output_keeps_full_content():
    tmp_dir = _make_workspace_tmp_dir()
    store = ArtifactStore(base_dir=str(tmp_dir / "temp_data"))
    materializer = PromptMaterializer(artifact_store=store, large_data_threshold=50)
    result = success_result(
        {"city": "Shanghai", "value": "x" * 100},
        answer="已找到统计结果",
        tool_name="preview_data_structure",
        output_type="json",
    )

    try:
        observation = materializer.materialize_tool_observation(
            result,
            ObservationDecision(mode="summarize"),
            tool_name="preview_data_structure",
        )

        assert observation.startswith("已找到统计结果")
        assert "```json" in observation
        assert json.dumps(result.content, ensure_ascii=False, indent=2) in observation
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_artifact_reference_output_persists_session_and_ttl():
    tmp_dir = _make_workspace_tmp_dir()
    store = ArtifactStore(base_dir=str(tmp_dir / "temp_data"))
    materializer = PromptMaterializer(artifact_store=store, large_data_threshold=50)
    result = success_result(
        [{"value": "x" * 120}],
        summary="数据过大",
        tool_name="preview_data_structure",
        output_type="json",
        metadata={"total_count": 1, "data_type": "List"},
    )

    try:
        observation = materializer.materialize_tool_observation(
            result,
            ObservationDecision(mode="artifact_ref", artifact_ttl_seconds=600),
            tool_name="preview_data_structure",
            session_id="session-1",
        )

        assert "数据已存储:" in observation
        assert len(result.artifacts) == 1
        assert result.artifacts[0].path in observation
        assert result.artifacts[0].path.endswith(".json")
        assert result.artifacts[0].metadata["session_id"] == "session-1"
        assert "expires_at" in result.artifacts[0].metadata
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_artifact_reference_output_keeps_full_sample_preview():
    tmp_dir = _make_workspace_tmp_dir()
    store = ArtifactStore(base_dir=str(tmp_dir / "temp_data"))
    materializer = PromptMaterializer(artifact_store=store, large_data_threshold=50)
    sample = {"value": "x" * 300}
    result = success_result(
        [{"value": "x" * 120}],
        summary="数据过大",
        tool_name="preview_data_structure",
        output_type="json",
        metadata={"total_count": 1, "data_type": "List", "sample": sample},
    )

    try:
        observation = materializer.materialize_tool_observation(
            result,
            ObservationDecision(mode="artifact_ref", artifact_ttl_seconds=600),
            tool_name="preview_data_structure",
            session_id="session-1",
        )

        assert json.dumps(sample, ensure_ascii=False) in observation
        assert "..." not in observation.split("样本: ", 1)[1]
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_large_read_file_uses_original_source_reference_instead_of_new_artifact():
    tmp_dir = _make_workspace_tmp_dir()
    store = ArtifactStore(base_dir=str(tmp_dir / "temp_data"))
    materializer = PromptMaterializer(artifact_store=store, large_data_threshold=50)
    result = success_result(
        "x" * 200,
        summary="文件读取成功",
        tool_name="read_file",
        output_type="text",
        metadata={
            "file_path": "E:/data/source.json",
            "start_line": 1,
            "end_line": 200,
            "has_more": True,
            "next_offset": 201,
        },
    )

    try:
        observation = materializer.materialize_tool_observation(
            result,
            ObservationDecision(mode="artifact_ref", artifact_ttl_seconds=600),
            tool_name="read_file",
            session_id="session-1",
        )

        assert "原始文件: E:/data/source.json" in observation
        assert "如需后续内容，请继续调用 read_file" in observation
        assert "offset=" in observation
        assert "数据已存储:" not in observation
        assert len(result.artifacts) == 0
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_answer_and_data_detail_output():
    tmp_dir = _make_workspace_tmp_dir()
    store = ArtifactStore(base_dir=str(tmp_dir / "temp_data"))
    materializer = PromptMaterializer(artifact_store=store, large_data_threshold=500)
    result = success_result(
        {"city": "Shanghai", "value": 12},
        answer="已找到统计结果",
        tool_name="preview_data_structure",
        output_type="json",
    )

    try:
        observation = materializer.materialize_tool_observation(
            result,
            ObservationDecision(mode="inline"),
            tool_name="preview_data_structure",
        )

        assert observation.startswith("已找到统计结果")
        assert "数据详情:" in observation
        expected_snippet = json.dumps(result.content, ensure_ascii=False, indent=2)
        assert expected_snippet in observation
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_create_map_observation_includes_artifact_id():
    tmp_dir = _make_workspace_tmp_dir()
    store = ArtifactStore(base_dir=str(tmp_dir / "temp_data"))
    materializer = PromptMaterializer(artifact_store=store, large_data_threshold=500)
    result = success_result(
        {
            "artifact_id": "viz_map123",
            "viz_type": "map",
            "title": "人口热力图",
            "preview": {
                "map_type": "heatmap",
                "total_points": 12,
                "center": [30.67, 104.06],
            },
        },
        summary="地图已生成：人口热力图（heatmap，12个数据点）",
        tool_name="create_map",
        output_type="map",
    )

    try:
        observation = materializer.materialize_tool_observation(
            result,
            ObservationDecision(mode="inline"),
            tool_name="create_map",
        )

        # MapObservationFormatter 输出结构化文本
        assert "viz_map123" in observation
        assert "人口热力图" in observation
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
