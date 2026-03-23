# -*- coding: utf-8 -*-

from tools.tool_output_type_audit import build_audit_rows, build_summary


def test_tool_output_type_audit_contains_expected_internal_tools():
    rows = build_audit_rows()
    rows_by_name = {row["tool_name"]: row for row in rows}

    assert "create_chart" not in rows_by_name
    assert "create_map" not in rows_by_name
    assert rows_by_name["activate_skill"]["normalized_output_type"] == "markdown"
    assert rows_by_name["execute_skill_script"]["normalized_output_type"] == "text"
    assert rows_by_name["get_skill_info"]["normalized_output_type"] == "json"
    assert rows_by_name["get_skill_info"]["raw_shape"] == "tool_execution_result"
    assert rows_by_name["preview_data_structure"]["normalized_output_type"] == "json"
    assert rows_by_name["read_file"]["normalized_output_type"] == "text"
    assert rows_by_name["mcp__*"]["normalized_output_type"] == "dynamic"
    assert rows_by_name["<agent_name>"]["raw_shape"] == "tool_execution_result"
    assert rows_by_name["<agent_name>"]["content_field"] == "content"
    assert rows_by_name["<agent_name>"]["normalized_branch"] == "direct_passthrough"
    assert rows_by_name["<agent_name>"]["classification_basis"] == "agent_outputs_are_not_tool_output_map_entries"


def test_tool_output_type_audit_summary_marks_dynamic_entries_and_reference_compatibility():
    rows = build_audit_rows()
    summary = build_summary(rows)

    assert summary["tool_count"] >= 10
    assert summary["sampled_tool_count"] >= 10
    assert "dynamic" in summary["normalized_output_type_counts"]
    assert "mcp__*" in summary["dynamic_tools"]
    assert summary["reference_incompatible_tools"] == []
    assert all(
        row["reference_compatible"]
        for row in rows
        if row["validation_mode"] == "sampled"
    )
