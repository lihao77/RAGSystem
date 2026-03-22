# -*- coding: utf-8 -*-

import json
import shutil
import tempfile
from pathlib import Path

from agents.monitoring.observation_window import ObservationWindowCollector


def test_observation_window_collector_builds_report():
    temp_dir = tempfile.mkdtemp(dir=Path(__file__).resolve().parent)
    storage_path = Path(temp_dir) / "observation_window.json"
    collector = ObservationWindowCollector(storage_path=storage_path, persist_interval_seconds=0.0)
    collector.reset()

    try:
        collector.record_normalization(
            tool_name="read_document",
            output_type="text",
            branch="_normalize_document_result",
            success=True,
            native=False,
        )
        collector.record_materialization(
            tool_name="read_document",
            output_type="text",
            estimated_size=120,
            threshold=8000,
            used_artifact=False,
        )
        collector.record_normalization(
            tool_name="execute_code",
            output_type="json",
            branch="standard_result",
            success=True,
            native=True,
        )
        collector.record_materialization(
            tool_name="execute_code",
            output_type="json",
            estimated_size=12000,
            threshold=8000,
            used_artifact=True,
        )
        collector.record_artifact_saved(
            tool_name="execute_code",
            artifact_type="json",
            size=2048,
        )
        collector.record_compression(status="success", replaced_messages=3)
        collector.record_trim(trimmed_messages=2)

        report = collector.save_report()

        assert report["counts"]["normalized_results"] == 2
        assert report["counts"]["native_results"] == 1
        assert report["output_type_distribution"]["text"] == 1
        assert report["output_type_distribution"]["json"] == 1
        assert report["threshold_stats"]["triggered"] == 1
        assert report["threshold_stats"]["not_triggered"] == 1
        assert report["artifact_stats"]["average_size_bytes"] == 2048
        assert report["compression_stats"]["hit_rate"] == 1.0
        assert report["compression_stats"]["replaced_messages"] == 3
        assert report["trim_stats"]["trimmed_messages"] == 2
        assert report["spill_stats"]["count"] == 1
        tool_coverage = {item["tool_name"]: item for item in report["tool_coverage"]}
        assert tool_coverage["read_document"]["native_results"] == 0
        assert tool_coverage["execute_code"]["native_results"] == 1

        persisted = json.loads(Path(storage_path).read_text(encoding="utf-8"))
        assert persisted["totals"]["artifact_saves"] == 1
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_observation_window_collector_backfills_missing_fields_from_legacy_file():
    temp_dir = tempfile.mkdtemp(dir=Path(__file__).resolve().parent)
    storage_path = Path(temp_dir) / "observation_window.json"
    storage_path.write_text(
        json.dumps(
            {
                "totals": {
                    "normalized_results": 2,
                    "materialized_results": 3,
                    "artifact_saves": 0,
                },
                "tools": {
                    "legacy_tool": {
                        "normalized_results": 2,
                        "success_count": 2,
                        "failure_count": 0,
                        "materialized_results": 0,
                        "inline_count": 0,
                        "artifact_ref_count": 0,
                        "artifact_saves": 0,
                        "artifact_bytes": 0,
                        "output_type_distribution": {"text": 2},
                        "normalize_branch_distribution": {"standard_result": 2},
                        "inline_size_samples": [],
                        "artifact_size_samples": [],
                    }
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    try:
        collector = ObservationWindowCollector(
            storage_path=storage_path,
            persist_interval_seconds=0.0,
        )
        collector.record_normalization(
            tool_name="legacy_tool",
            output_type="text",
            branch="standard_result",
            success=True,
            native=False,
        )

        report = collector.build_report()

        assert report["counts"]["normalized_results"] == 3
        assert report["counts"]["native_results"] == 0
        assert report["tool_coverage"][0]["tool_name"] == "legacy_tool"
        assert report["tool_coverage"][0]["native_results"] == 0
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
