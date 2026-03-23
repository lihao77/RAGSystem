# -*- coding: utf-8 -*-

import json
import shutil
import tempfile
import time
from pathlib import Path

from agents.artifacts import ArtifactStore
from agents.context.observation_policy import ObservationPolicy
from agents.context.prompt_materializer import PromptMaterializer
from agents.monitoring.observation_window import ObservationWindowCollector
from services.conversation_store import ConversationStore
from tools.result_normalizer import ToolResultNormalizer
from tools.response_builder import success_result


def _make_temp_dir() -> str:
    return tempfile.mkdtemp(dir=Path(__file__).resolve().parent)


def _render_observation(*, temp_dir: str, collector: ObservationWindowCollector, result, is_skills_tool: bool = False) -> str:
    artifact_store = ArtifactStore(
        base_dir=temp_dir,
        observation_window=collector,
    )
    normalizer = ToolResultNormalizer(observation_window=collector)
    policy = ObservationPolicy()
    materializer = PromptMaterializer(
        artifact_store=artifact_store,
        observation_window=collector,
        large_data_threshold=policy.large_data_threshold,
    )
    normalized = normalizer.normalize(result, tool_name=result.tool_name)
    decision = policy.decide(normalized, is_skills_tool=is_skills_tool)
    return materializer.materialize_tool_observation(
        normalized,
        decision,
        tool_name=result.tool_name,
        is_skills_tool=is_skills_tool,
    )


def test_phase_ab_smoke_small_json_is_inlined():
    temp_dir = _make_temp_dir()
    try:
        collector = ObservationWindowCollector(
            storage_path=Path(temp_dir) / "observation_window.json",
            persist_interval_seconds=0.0,
        )
        observation = _render_observation(
            temp_dir=temp_dir,
            collector=collector,
            result=success_result(
                content=[{"city": "Shanghai", "value": 12}],
                summary="查询成功",
                output_type="json",
                tool_name="execute_code",
            ),
        )

        assert observation.startswith("✅ 查询成功")
        assert "```json" in observation
        assert '"city": "Shanghai"' in observation
        assert "📁 数据已存储:" not in observation
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_phase_ab_smoke_skills_result_stays_markdown_like():
    temp_dir = _make_temp_dir()
    try:
        collector = ObservationWindowCollector(
            storage_path=Path(temp_dir) / "observation_window.json",
            persist_interval_seconds=0.0,
        )
        observation = _render_observation(
            temp_dir=temp_dir,
            collector=collector,
            result=success_result(
                content={
                    "skill_name": "demo",
                    "main_content": "# Demo Skill\nDo the thing.",
                },
                summary="Skill 已激活",
                output_type="markdown",
                tool_name="activate_skill",
            ),
            is_skills_tool=True,
        )

        assert observation.startswith("✅ Skill 已激活")
        assert "# Demo Skill" in observation
        assert "Do the thing." in observation
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_phase_ab_smoke_large_payload_writes_artifact_reference():
    temp_dir = _make_temp_dir()
    try:
        collector = ObservationWindowCollector(
            storage_path=Path(temp_dir) / "observation_window.json",
            persist_interval_seconds=0.0,
        )
        large_results = [{"index": idx, "value": "x" * 200} for idx in range(80)]

        observation = _render_observation(
            temp_dir=temp_dir,
            collector=collector,
            result=success_result(
                content=large_results,
                summary="大数据集",
                output_type="json",
                metadata={
                    "total_count": len(large_results),
                    "data_type": "list",
                    "fields": [
                        {"name": "index", "type": "int"},
                        {"name": "value", "type": "str"},
                    ],
                },
                tool_name="execute_code",
            ),
        )

        assert "📁 数据已存储:" in observation
        assert "execute_code 读取此文件" in observation

        prefix = "📁 数据已存储: "
        artifact_line = next(line for line in observation.splitlines() if line.startswith(prefix))
        artifact_path = artifact_line[len(prefix):]

        assert Path(artifact_path).exists()
        assert Path(artifact_path).name.startswith("data_")
        assert Path(artifact_path).suffix == ".json"
        with open(artifact_path, "r", encoding="utf-8") as file_obj:
            persisted = json.load(file_obj)
        assert persisted == large_results
        report = collector.build_report()
        assert report["threshold_stats"]["triggered"] == 1
        assert report["artifact_stats"]["count"] == 1
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_phase_ab_smoke_large_text_payload_read_file_stays_inline():
    temp_dir = _make_temp_dir()
    try:
        collector = ObservationWindowCollector(
            storage_path=Path(temp_dir) / "observation_window.json",
            persist_interval_seconds=0.0,
        )
        observation = _render_observation(
            temp_dir=temp_dir,
            collector=collector,
            result=success_result(
                content="A" * 9001,
                summary="文件内容过大",
                output_type="text",
                tool_name="read_file",
                metadata={
                    "file_path": "demo.txt",
                    "start_line": 1,
                    "end_line": 999,
                    "has_more": True,
                    "next_offset": 1000,
                },
            ),
        )

        assert observation.startswith("✅ 文件内容过大")
        assert "📁 数据已存储:" not in observation
        assert observation.endswith("A" * 9001)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_phase_ab_smoke_document_tools_are_normalized_explicitly():
    normalizer = ToolResultNormalizer()

    read_result = normalizer.normalize(
        success_result(
            content="line 1\nline 2",
            summary="文件读取成功",
            output_type="text",
            metadata={
                "file_path": "demo.txt",
                "start_line": 1,
                "end_line": 2,
                "has_more": False,
                "next_offset": None,
            },
            tool_name="read_file",
        ),
    )
    preview_result = normalizer.normalize(
        success_result(
            content={"file_type": "json", "structure": {"type": "object"}},
            summary="结构预览成功",
            output_type="json",
            metadata={
                "file_type": "json",
                "file_size": 18,
            },
            tool_name="preview_data_structure",
        ),
    )

    assert read_result.output_type == "text"
    assert read_result.content == "line 1\nline 2"
    assert read_result.metadata["file_path"] == "demo.txt"
    assert preview_result.output_type == "json"
    assert preview_result.content == {"file_type": "json", "structure": {"type": "object"}}
    assert preview_result.metadata["file_type"] == "json"


def test_phase_ab_smoke_conversation_store_uses_artifact_store_cleanup():
    temp_dir = _make_temp_dir()
    try:
        collector = ObservationWindowCollector(
            storage_path=Path(temp_dir) / "observation_window.json",
            persist_interval_seconds=0.0,
        )
        artifact_store = ArtifactStore(
            base_dir=temp_dir,
            observation_window=collector,
        )
        conversation_store = ConversationStore(
            db_path=str(Path(temp_dir) / "test.db"),
            cleanup_interval_seconds=9999,
            start_cleanup_thread=False,
            artifact_store=artifact_store,
        )

        stale = artifact_store.save_json(session_id="s1", tool_name="demo", data={"old": True})
        fresh = artifact_store.save_json(session_id="s1", tool_name="demo", data={"new": True})
        stale_text = artifact_store.save_text(session_id="s1", tool_name="demo", content="old text")

        old_time = time.time() - (2 * 24 * 60 * 60)
        Path(stale.path).touch()
        Path(fresh.path).touch()
        Path(stale_text.path).touch()
        import os
        os.utime(stale.path, (old_time, old_time))
        os.utime(stale_text.path, (old_time, old_time))

        conversation_store._cleanup_temp_data_files()

        assert not Path(stale.path).exists()
        assert not Path(stale_text.path).exists()
        assert Path(fresh.path).exists()
    finally:
        try:
            conversation_store.close()
        except Exception:
            pass
        shutil.rmtree(temp_dir, ignore_errors=True)
