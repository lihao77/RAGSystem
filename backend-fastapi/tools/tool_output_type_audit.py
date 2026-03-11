# -*- coding: utf-8 -*-
"""Audit current tool result shapes and normalized output types."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tools.result_normalizer import TOOL_OUTPUT_TYPE_MAP


_INTERNAL_TOOL_SPECS: List[Dict[str, Any]] = [
    {
        "tool_name": "transform_data",
        "category": "builtin",
        "source": "tools/tool_executor_modules/data_tools.py",
        "raw_shape": "standard_success",
        "content_field": "data.results",
        "content_kind": "list_or_dict",
        "normalized_branch": "standard_result",
        "normalized_output_type": "json",
        "classification_basis": "fallback_by_content_kind",
        "notes": "success_response(results=result_data); result_data usually list/dict",
    },
    {
        "tool_name": "process_data_file",
        "category": "builtin",
        "source": "tools/tool_executor_modules/data_tools.py",
        "raw_shape": "standard_success",
        "content_field": "data.results",
        "content_kind": "list_or_dict",
        "normalized_branch": "standard_result",
        "normalized_output_type": "json",
        "classification_basis": "fallback_by_content_kind",
        "notes": "success_response(results=processed_data); processed_data is JSON/CSV loaded records",
    },
    {
        "tool_name": "generate_chart",
        "category": "builtin",
        "source": "tools/tool_executor_modules/visualization_tools.py",
        "raw_shape": "standard_success",
        "content_field": "data.results",
        "content_kind": "dict",
        "normalized_branch": "standard_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["generate_chart"],
        "classification_basis": "explicit_tool_map",
        "notes": "results contains echarts_config and chart_type",
    },
    {
        "tool_name": "generate_map",
        "category": "builtin",
        "source": "tools/tool_executor_modules/visualization_tools.py",
        "raw_shape": "standard_success",
        "content_field": "data.results",
        "content_kind": "dict",
        "normalized_branch": "standard_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["generate_map"],
        "classification_basis": "explicit_tool_map",
        "notes": "results contains map payload such as heat_data/markers/bounds",
    },
    {
        "tool_name": "activate_skill",
        "category": "skill",
        "source": "tools/tool_executor_modules/skill_tools.py",
        "raw_shape": "standard_success",
        "content_field": "data.results",
        "content_kind": "dict_with_main_content",
        "normalized_branch": "standard_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["activate_skill"],
        "classification_basis": "explicit_tool_map",
        "notes": "results.main_content is SKILL.md body",
    },
    {
        "tool_name": "load_skill_resource",
        "category": "skill",
        "source": "tools/tool_executor_modules/skill_tools.py",
        "raw_shape": "standard_success",
        "content_field": "data.results",
        "content_kind": "dict_with_content",
        "normalized_branch": "standard_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["load_skill_resource"],
        "classification_basis": "explicit_tool_map",
        "notes": "results.content is loaded resource file body",
    },
    {
        "tool_name": "execute_skill_script",
        "category": "skill",
        "source": "tools/tool_executor_modules/skill_tools.py",
        "raw_shape": "standard_success",
        "content_field": "data.results",
        "content_kind": "dict",
        "normalized_branch": "standard_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["execute_skill_script"],
        "classification_basis": "explicit_tool_map",
        "notes": "results contains stdout/stderr/return_code",
    },
    {
        "tool_name": "read_document",
        "category": "document",
        "source": "tools/document_executor.py",
        "raw_shape": "flat_success",
        "content_field": "content",
        "content_kind": "str",
        "normalized_branch": "_normalize_document_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["read_document"],
        "classification_basis": "explicit_tool_map",
        "notes": "flat dict with content/file_type/file_path/char_count",
    },
    {
        "tool_name": "chunk_document",
        "category": "document",
        "source": "tools/document_executor.py",
        "raw_shape": "flat_success",
        "content_field": "chunks",
        "content_kind": "list",
        "normalized_branch": "_normalize_document_chunk_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["chunk_document"],
        "classification_basis": "explicit_tool_map",
        "notes": "flat dict with chunks/total_chunks/strategy",
    },
    {
        "tool_name": "extract_structured_data",
        "category": "document",
        "source": "tools/document_executor.py",
        "raw_shape": "flat_success",
        "content_field": "data",
        "content_kind": "dict",
        "normalized_branch": "_normalize_document_extract_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["extract_structured_data"],
        "classification_basis": "explicit_tool_map",
        "notes": "flat dict with extracted JSON object in data",
    },
    {
        "tool_name": "merge_extracted_data",
        "category": "document",
        "source": "tools/document_executor.py",
        "raw_shape": "flat_success",
        "content_field": "data",
        "content_kind": "list_or_dict",
        "normalized_branch": "_normalize_document_merge_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["merge_extracted_data"],
        "classification_basis": "explicit_tool_map",
        "notes": "flat dict with merged extraction result in data",
    },
    {
        "tool_name": "write_file",
        "category": "document",
        "source": "tools/document_executor.py",
        "raw_shape": "standard_success",
        "content_field": "data.results",
        "content_kind": "dict",
        "normalized_branch": "standard_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["write_file"],
        "classification_basis": "explicit_tool_map",
        "notes": "results contains file_path/file_size, but formatter treats tool as text-oriented utility",
    },
    {
        "tool_name": "read_file",
        "category": "document",
        "source": "tools/document_executor.py",
        "raw_shape": "standard_success",
        "content_field": "data.results",
        "content_kind": "str",
        "normalized_branch": "standard_result",
        "normalized_output_type": TOOL_OUTPUT_TYPE_MAP["read_file"],
        "classification_basis": "explicit_tool_map",
        "notes": "results is file content string",
    },
    {
        "tool_name": "execute_code",
        "category": "builtin",
        "source": "tools/code_sandbox.py",
        "raw_shape": "dynamic",
        "content_field": "depends_on_result",
        "content_kind": "unknown",
        "normalized_branch": "standard_result_or_direct_result_or_error",
        "normalized_output_type": "dynamic",
        "classification_basis": "cannot_be_fixed_without_runtime_result",
        "notes": "sandbox output shape depends on code result payload",
    },
    {
        "tool_name": "mcp__*",
        "category": "mcp",
        "source": "tools/tool_executor_modules/dispatcher.py",
        "raw_shape": "dynamic",
        "content_field": "server_defined",
        "content_kind": "unknown",
        "normalized_branch": "standard_result_or_error",
        "normalized_output_type": "dynamic",
        "classification_basis": "depends_on_remote_tool_payload",
        "notes": "usually fallback: str->text, dict/list->json, failure->error",
    },
    {
        "tool_name": "<agent_name>",
        "category": "agent_delegation",
        "source": "agents/implementations/master/tool_router.py",
        "raw_shape": "agent_response",
        "content_field": "data.results",
        "content_kind": "agent_defined",
        "normalized_branch": "standard_result_or_error",
        "normalized_output_type": "dynamic",
        "classification_basis": "agent_outputs_are_not_tool_output_map_entries",
        "notes": "kgqa_agent/chart_agent are agent names, not tool names in TOOL_OUTPUT_TYPE_MAP",
    },
]


def build_audit_rows() -> List[Dict[str, Any]]:
    return sorted(_INTERNAL_TOOL_SPECS, key=lambda item: item["tool_name"])


def build_summary(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    counts: Dict[str, int] = {}
    dynamic_tools: List[str] = []
    for row in rows:
        output_type = row["normalized_output_type"]
        counts[output_type] = counts.get(output_type, 0) + 1
        if output_type == "dynamic":
            dynamic_tools.append(row["tool_name"])
    return {
        "tool_count": len(rows),
        "normalized_output_type_counts": counts,
        "dynamic_tools": dynamic_tools,
    }


def _render_table(rows: List[Dict[str, Any]]) -> str:
    headers = [
        "tool_name",
        "normalized_output_type",
        "raw_shape",
        "content_field",
        "normalized_branch",
        "classification_basis",
    ]
    widths = {
        header: max(len(header), *(len(str(row[header])) for row in rows))
        for header in headers
    }
    lines = []
    lines.append(" | ".join(header.ljust(widths[header]) for header in headers))
    lines.append("-+-".join("-" * widths[header] for header in headers))
    for row in rows:
        lines.append(" | ".join(str(row[header]).ljust(widths[header]) for header in headers))
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit tool output-type classification from current code rules.")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of table output.")
    args = parser.parse_args()

    rows = build_audit_rows()
    payload = {
        "summary": build_summary(rows),
        "rows": rows,
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    print(json.dumps(payload["summary"], ensure_ascii=False, indent=2))
    print()
    print(_render_table(rows))


if __name__ == "__main__":
    main()
