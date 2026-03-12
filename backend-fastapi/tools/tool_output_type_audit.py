# -*- coding: utf-8 -*-
"""Audit tool result shapes using registered handlers and executable samples."""

from __future__ import annotations

import argparse
import inspect
import json
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, List

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tools.result_normalizer import TOOL_OUTPUT_TYPE_MAP, ToolResultNormalizer
from tools.result_references import resolve_result_path
from tools.result_schema import ToolExecutionResult
from tools.tool_executor_modules.dispatcher import (
    DOCUMENT_TOOL_NAMES,
    TOOL_HANDLERS,
    _execute_document_tool,
)


_DYNAMIC_ENTRIES: List[Dict[str, Any]] = [
    {
        "tool_name": "execute_code",
        "category": "builtin",
        "source": "tools/code_sandbox.py",
        "raw_shape": "dynamic",
        "content_field": "depends_on_result",
        "content_kind": "unknown",
        "normalized_branch": "direct_passthrough",
        "normalized_output_type": "dynamic",
        "classification_basis": "requires_runtime_payload",
        "notes": "sandbox output shape depends on executed code",
        "validation_mode": "dynamic",
        "reference_compatible": False,
    },
    {
        "tool_name": "mcp__*",
        "category": "mcp",
        "source": "tools/tool_executor_modules/dispatcher.py",
        "raw_shape": "dynamic",
        "content_field": "server_defined",
        "content_kind": "unknown",
        "normalized_branch": "direct_passthrough",
        "normalized_output_type": "dynamic",
        "classification_basis": "remote_server_defined",
        "notes": "remote MCP servers define payload shape",
        "validation_mode": "dynamic",
        "reference_compatible": False,
    },
    {
        "tool_name": "<agent_name>",
        "category": "agent_delegation",
        "source": "agents/implementations/orchestrator/executor.py",
        "raw_shape": "tool_execution_result",
        "content_field": "content",
        "content_kind": "agent_defined",
        "normalized_branch": "direct_passthrough",
        "normalized_output_type": "dynamic",
        "classification_basis": "agent_outputs_are_not_tool_output_map_entries",
        "notes": "delegated agent payload is now emitted as ToolExecutionResult",
        "validation_mode": "dynamic",
        "reference_compatible": True,
    },
]


@contextmanager
def _patched_attr(module: Any, attr_name: str, replacement: Any):
    original = getattr(module, attr_name)
    setattr(module, attr_name, replacement)
    try:
        yield
    finally:
        setattr(module, attr_name, original)


def _sample_transform_data(_: Path) -> Any:
    return TOOL_HANDLERS["transform_data"](
        python_code="result = [{'city': 'Shanghai', 'value': 12}]",
        description="sample",
    )


def _sample_process_data_file(temp_dir: Path) -> Any:
    source_path = temp_dir / "input.json"
    source_path.write_text(
        json.dumps([{"city": "Shanghai", "value": 12}], ensure_ascii=False),
        encoding="utf-8",
    )
    python_code = (
        "with open(source_path, 'r', encoding='utf-8') as src:\n"
        "    data = json.load(src)\n"
        "with open(result_path, 'w', encoding='utf-8') as dst:\n"
        "    json.dump(data, dst, ensure_ascii=False)\n"
    )
    return TOOL_HANDLERS["process_data_file"](
        source_path=str(source_path),
        python_code=python_code,
        description="sample",
    )


def _sample_generate_chart(_: Path) -> Any:
    return TOOL_HANDLERS["generate_chart"](
        data=[{"year": "2024", "value": 12}, {"year": "2025", "value": 18}],
        chart_type="line",
        title="sample",
        x_field="year",
        y_field="value",
    )


def _sample_update_chart_config(_: Path) -> Any:
    draft = TOOL_HANDLERS["generate_chart"](
        data=[{"year": "2024", "value": 12}, {"year": "2025", "value": 18}],
        chart_type="line",
        title="sample",
        x_field="year",
        y_field="value",
        session_id="audit-session",
    )
    candidate_id = draft.content["candidate_id"]
    return TOOL_HANDLERS["update_chart_config"](
        candidate_id=candidate_id,
        config_patch={"title": {"text": "updated sample"}},
        session_id="audit-session",
    )


def _sample_present_chart(_: Path) -> Any:
    draft = TOOL_HANDLERS["generate_chart"](
        data=[{"year": "2024", "value": 12}, {"year": "2025", "value": 18}],
        chart_type="line",
        title="sample",
        x_field="year",
        y_field="value",
        session_id="audit-session",
    )
    candidate_id = draft.content["candidate_id"]
    return TOOL_HANDLERS["present_chart"](
        candidate_id=candidate_id,
        session_id="audit-session",
    )


def _sample_generate_map(_: Path) -> Any:
    return TOOL_HANDLERS["generate_map"](
        data=[
            {"name": "A", "value": 12, "geometry": "POINT (121.47 31.23)"},
            {"name": "B", "value": 8, "geometry": "POINT (121.50 31.20)"},
        ],
        map_type="marker",
        title="sample",
        name_field="name",
        value_field="value",
        geometry_field="geometry",
    )


class _StubSkill:
    def __init__(self, skill_dir: Path):
        self.name = "demo-skill"
        self.description = "demo description"
        self.content = "# Demo Skill\nUse the skill."
        self.skill_dir = skill_dir

    def get_resource_file_content(self, file_name: str) -> str | None:
        if file_name == "reference.md":
            return "resource body"
        return None

    def has_scripts(self) -> bool:
        return True

    def execute_script(self, script_name: str, arguments: list[str] | None = None, timeout: int = 30) -> Dict[str, Any]:
        del script_name, arguments, timeout
        return {"stdout": "ok", "stderr": "", "return_code": 0}


class _StubSkillLoader:
    def __init__(self, skill_dir: Path):
        self._skill = _StubSkill(skill_dir)

    def load_all_skills(self):
        return [self._skill]

    def find_skill_metadata(self, skill_name: str):
        if skill_name != self._skill.name:
            return None
        return {
            "name": self._skill.name,
            "description": self._skill.description,
            "skill_dir": self._skill.skill_dir,
            "metadata": {"name": self._skill.name, "description": self._skill.description},
        }

    def list_skill_names(self):
        return [self._skill.name]

    def count_skill_resources(self, skill_dir: Path) -> int:
        return 1 if skill_dir == self._skill.skill_dir else 0


def _run_skill_sample(tool_name: str, temp_dir: Path) -> Any:
    import agents.skills.skill_loader as skill_loader_module

    skill_dir = temp_dir / "demo-skill"
    skill_dir.mkdir(exist_ok=True)
    (skill_dir / "scripts").mkdir(exist_ok=True)
    (skill_dir / "reference.md").write_text("resource body", encoding="utf-8")
    stub_loader = _StubSkillLoader(skill_dir)

    with _patched_attr(skill_loader_module, "get_skill_loader", lambda skills_dir=None: stub_loader):
        if tool_name == "activate_skill":
            return TOOL_HANDLERS[tool_name](skill_name="demo-skill")
        if tool_name == "load_skill_resource":
            return TOOL_HANDLERS[tool_name](skill_name="demo-skill", resource_file="reference.md")
        if tool_name == "execute_skill_script":
            return TOOL_HANDLERS[tool_name](
                skill_name="demo-skill",
                script_name="run.py",
                arguments=["--sample"],
            )
        if tool_name == "get_skill_info":
            return TOOL_HANDLERS[tool_name](skill_name="demo-skill")
    raise KeyError(tool_name)


def _sample_read_document(temp_dir: Path) -> Any:
    path = temp_dir / "doc.txt"
    path.write_text("document body", encoding="utf-8")
    return _execute_document_tool("read_document", {"file_path": str(path)})


def _sample_chunk_document(_: Path) -> Any:
    return _execute_document_tool(
        "chunk_document",
        {"content": "abcdefghij", "chunk_size": 4, "chunk_overlap": 1},
    )


def _sample_extract_structured_data(_: Path) -> Any:
    import model_adapter

    class _FakeAdapter:
        def chat_completion(self, messages, response_format=None):
            del messages, response_format
            return {"content": "{\"name\": \"Alice\", \"age\": 30}"}

    with _patched_attr(model_adapter, "get_default_adapter", lambda: _FakeAdapter()):
        return _execute_document_tool(
            "extract_structured_data",
            {
                "text": "Alice is 30 years old.",
                "schema": {"type": "object", "properties": {"name": {"type": "string"}, "age": {"type": "number"}}},
            },
        )


def _sample_merge_extracted_data(_: Path) -> Any:
    return _execute_document_tool(
        "merge_extracted_data",
        {
            "data_list": [[{"id": 1, "name": "Alice"}], [{"id": 2, "name": "Bob"}]],
            "merge_strategy": "append",
        },
    )


def _sample_write_file(temp_dir: Path) -> Any:
    path = temp_dir / "output.txt"
    return _execute_document_tool(
        "write_file",
        {"content": "hello world", "file_path": str(path)},
    )


def _sample_read_file(temp_dir: Path) -> Any:
    path = temp_dir / "sample.txt"
    path.write_text("hello world", encoding="utf-8")
    return _execute_document_tool(
        "read_file",
        {"file_path": str(path)},
    )


_SAMPLE_RUNNERS: Dict[str, Callable[[Path], Any]] = {
    "transform_data": _sample_transform_data,
    "process_data_file": _sample_process_data_file,
    "generate_chart": _sample_generate_chart,
    "update_chart_config": _sample_update_chart_config,
    "present_chart": _sample_present_chart,
    "generate_map": _sample_generate_map,
    "activate_skill": lambda temp_dir: _run_skill_sample("activate_skill", temp_dir),
    "load_skill_resource": lambda temp_dir: _run_skill_sample("load_skill_resource", temp_dir),
    "execute_skill_script": lambda temp_dir: _run_skill_sample("execute_skill_script", temp_dir),
    "get_skill_info": lambda temp_dir: _run_skill_sample("get_skill_info", temp_dir),
    "read_document": _sample_read_document,
    "chunk_document": _sample_chunk_document,
    "extract_structured_data": _sample_extract_structured_data,
    "merge_extracted_data": _sample_merge_extracted_data,
    "write_file": _sample_write_file,
    "read_file": _sample_read_file,
}


def _registered_tool_names() -> List[str]:
    return sorted(set(TOOL_HANDLERS) | set(DOCUMENT_TOOL_NAMES))


def _tool_category(tool_name: str) -> str:
    if tool_name in {"activate_skill", "load_skill_resource", "execute_skill_script", "get_skill_info"}:
        return "skill"
    if tool_name in DOCUMENT_TOOL_NAMES:
        return "document"
    return "builtin"


def _tool_source(tool_name: str) -> str:
    if tool_name in TOOL_HANDLERS:
        source = inspect.getsourcefile(TOOL_HANDLERS[tool_name])
        if source:
            return str(Path(source).resolve().relative_to(ROOT_DIR)).replace("\\", "/")
    if tool_name in DOCUMENT_TOOL_NAMES:
        return "tools/document_executor.py"
    return "unknown"


def _infer_raw_shape(raw_result: Any) -> str:
    if isinstance(raw_result, ToolExecutionResult):
        return "tool_execution_result"
    raise TypeError(f"unexpected sampled raw result: {type(raw_result).__name__}")


def _infer_content_field(raw_result: Any) -> str:
    if isinstance(raw_result, ToolExecutionResult):
        return "content"
    raise TypeError(f"unexpected sampled raw result: {type(raw_result).__name__}")


def _infer_content_kind(value: Any) -> str:
    if isinstance(value, dict):
        if "main_content" in value:
            return "dict_with_main_content"
        if "content" in value:
            return "dict_with_content"
        return "dict"
    if isinstance(value, list):
        return "list"
    if isinstance(value, str):
        return "str"
    if value is None:
        return "none"
    return type(value).__name__


def _infer_classification_basis(tool_name: str, normalized_output_type: str) -> str:
    if tool_name in TOOL_OUTPUT_TYPE_MAP:
        return "explicit_tool_map"
    if normalized_output_type in {"json", "text"}:
        return "fallback_by_content_kind"
    return "sampled_execution"


def _infer_notes(raw_result: Any, normalized_result: Any) -> str:
    if isinstance(raw_result, ToolExecutionResult):
        return "sampled direct ToolExecutionResult"
    return f"sampled payload normalized into {normalized_result.output_type}"


def _sampled_row(tool_name: str) -> Dict[str, Any]:
    if tool_name not in _SAMPLE_RUNNERS:
        raise AssertionError(f"tool_output_type_audit 缺少工具 {tool_name} 的样例执行器")

    with tempfile.TemporaryDirectory(prefix=f"audit_{tool_name}_") as temp_dir:
        raw_result = _SAMPLE_RUNNERS[tool_name](Path(temp_dir))

    normalizer = ToolResultNormalizer()
    normalized = normalizer.normalize(raw_result, tool_name=tool_name)

    return {
        "tool_name": tool_name,
        "category": _tool_category(tool_name),
        "source": _tool_source(tool_name),
        "raw_shape": _infer_raw_shape(raw_result),
        "content_field": _infer_content_field(raw_result),
        "content_kind": _infer_content_kind(normalized.content),
        "normalized_branch": "direct_passthrough",
        "normalized_output_type": normalized.output_type,
        "classification_basis": _infer_classification_basis(tool_name, normalized.output_type),
        "notes": _infer_notes(raw_result, normalized),
        "validation_mode": "sampled",
        "reference_compatible": resolve_result_path(raw_result, "content") is not None,
    }


def build_audit_rows() -> List[Dict[str, Any]]:
    rows = [_sampled_row(tool_name) for tool_name in _registered_tool_names()]
    rows.extend(_DYNAMIC_ENTRIES)
    return sorted(rows, key=lambda item: item["tool_name"])


def build_summary(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    counts: Dict[str, int] = {}
    dynamic_tools: List[str] = []
    sampled_tools: List[str] = []
    incompatible_tools: List[str] = []
    for row in rows:
        output_type = row["normalized_output_type"]
        counts[output_type] = counts.get(output_type, 0) + 1
        if output_type == "dynamic":
            dynamic_tools.append(row["tool_name"])
        if row.get("validation_mode") == "sampled":
            sampled_tools.append(row["tool_name"])
        if row.get("validation_mode") == "sampled" and not row.get("reference_compatible", False):
            incompatible_tools.append(row["tool_name"])
    return {
        "tool_count": len(rows),
        "sampled_tool_count": len(sampled_tools),
        "normalized_output_type_counts": counts,
        "dynamic_tools": dynamic_tools,
        "reference_incompatible_tools": incompatible_tools,
    }


def _render_table(rows: List[Dict[str, Any]]) -> str:
    headers = [
        "tool_name",
        "normalized_output_type",
        "raw_shape",
        "content_field",
        "normalized_branch",
        "validation_mode",
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
    parser = argparse.ArgumentParser(description="Audit tool output types via sampled executions.")
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
