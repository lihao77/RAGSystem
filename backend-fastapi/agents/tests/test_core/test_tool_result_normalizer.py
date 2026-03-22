# -*- coding: utf-8 -*-

import logging
import shutil
import tempfile
from pathlib import Path

import pytest

from agents.monitoring.observation_window import ObservationWindowCollector
from tools.result_normalizer import ToolResultNormalizer
from tools.response_builder import success_result


def test_normalizer_rejects_legacy_standard_result_dict():
    normalizer = ToolResultNormalizer()

    with pytest.raises(TypeError, match="仅接受 ToolExecutionResult"):
        normalizer.normalize(
            {
                "success": True,
                "data": {
                    "results": [{"name": "alice"}],
                },
            },
            tool_name="execute_code",
        )


def test_normalizer_rejects_primitive_result_shape():
    normalizer = ToolResultNormalizer()

    with pytest.raises(TypeError, match="仅接受 ToolExecutionResult"):
        normalizer.normalize("raw text", tool_name="custom_tool")


def test_normalizer_passes_through_tool_execution_result_and_backfills_tool_name():
    normalizer = ToolResultNormalizer()

    raw = success_result(
        content={"name": "demo"},
        summary="ok",
        output_type="json",
    )

    normalized = normalizer.normalize(raw, tool_name="get_skill_info")

    assert normalized is raw
    assert normalized.tool_name == "get_skill_info"
    assert normalized.output_type == "json"


def test_normalizer_does_not_warn_for_native_tool_execution_result(caplog):
    normalizer = ToolResultNormalizer()
    caplog.set_level(logging.WARNING)

    normalizer.normalize(
        success_result(
            content={"name": "demo"},
            summary="ok",
            output_type="json",
        ),
        tool_name="get_skill_info",
    )

    assert caplog.text == ""


def test_normalizer_records_metrics_for_direct_tool_execution_result():
    temp_dir = tempfile.mkdtemp(dir=Path(__file__).resolve().parent)
    try:
        collector = ObservationWindowCollector(
            storage_path=Path(temp_dir) / "observation_window.json",
            persist_interval_seconds=0.0,
        )
        normalizer = ToolResultNormalizer(observation_window=collector)

        normalized = normalizer.normalize(
            success_result(
                content={"name": "demo"},
                summary="ok",
                output_type="json",
            ),
            tool_name="get_skill_info",
        )

        report = collector.build_report()
        get_skill_row = next(
            row for row in report["tool_coverage"] if row["tool_name"] == "get_skill_info"
        )

        assert normalized.tool_name == "get_skill_info"
        assert report["counts"]["normalized_results"] == 1
        assert report["counts"]["native_results"] == 1
        assert report["output_type_distribution"]["json"] == 1
        assert get_skill_row["normalized_results"] == 1
        assert get_skill_row["native_results"] == 1
        assert get_skill_row["normalize_branch_distribution"]["direct_passthrough"] == 1
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
