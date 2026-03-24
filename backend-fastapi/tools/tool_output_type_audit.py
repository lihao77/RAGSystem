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
from tools.bootstrap import bootstrap_tool_system
from tools.document_executor import edit_file, preview_data_structure, read_file, write_file
from tools.tool_executor_modules.dispatcher import TOOL_HANDLERS
from tools.tool_registry import get_tool_registry

bootstrap_tool_system()


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
        "tool_name": "request_user_input",
        "category": "builtin",
        "source": "tools/tool_executor_modules/builtin_tools.py",
        "raw_shape": "tool_execution_result",
        "content_field": "content",
        "content_kind": "text_or_empty",
        "normalized_branch": "direct_passthrough",
        "normalized_output_type": "text",
        "classification_basis": "interactive_runtime_tool",
        "notes": "interactive builtin tool requires runtime event bus and task registry",
        "validation_mode": "dynamic",
        "reference_compatible": True,
    },
    {
        "tool_name": "call_agent",
        "category": "agent_delegation",
        "source": "tools/tool_executor_modules/agent_tools.py",
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


_DYNAMIC_TOOL_NAMES = {
    entry["tool_name"]
    for entry in _DYNAMIC_ENTRIES
    if "*" not in entry["tool_name"]
}


@contextmanager
def _patched_attr(module: Any, attr_name: str, replacement: Any):
    original = getattr(module, attr_name)
    setattr(module, attr_name, replacement)
    try:
        yield
    finally:
        setattr(module, attr_name, original)


def _sample_visualization_chart(_: Path) -> Any:
    return TOOL_HANDLERS["execute_skill_script"](
        skill_name="visualization",
        script_name="create_chart.py",
        arguments=[
            "--data", '[{"year": "2024", "value": 12}, {"year": "2025", "value": 18}]',
            "--chart-type", "line",
            "--title", "sample",
            "--x-field", "year",
            "--y-field", "value",
        ],
        session_id="audit-session",
    )


def _sample_visualization_revise(_: Path) -> Any:
    draft = TOOL_HANDLERS["execute_skill_script"](
        skill_name="visualization",
        script_name="create_chart.py",
        arguments=[
            "--data", '[{"year": "2024", "value": 12}, {"year": "2025", "value": 18}]',
            "--chart-type", "line",
            "--title", "sample",
            "--x-field", "year",
            "--y-field", "value",
        ],
        session_id="audit-session",
    )
    artifact_id = draft.content["artifact_id"]
    return TOOL_HANDLERS["execute_skill_script"](
        skill_name="visualization",
        script_name="revise.py",
        arguments=[
            "--artifact-id", artifact_id,
            "--config-patch", '{"title":{"text":"updated sample"}}',
        ],
        session_id="audit-session",
    )


def _sample_visualization_map(_: Path) -> Any:
    return TOOL_HANDLERS["execute_skill_script"](
        skill_name="visualization",
        script_name="create_map.py",
        arguments=[
            "--data", '[{"name": "A", "value": 12, "geometry": "POINT (121.47 31.23)"}, {"name": "B", "value": 8, "geometry": "POINT (121.50 31.20)"}]',
            "--map-type", "marker",
            "--title", "sample",
            "--name-field", "name",
            "--value-field", "value",
            "--geometry-field", "geometry",
        ],
        session_id="audit-session",
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



def _sample_write_file(temp_dir: Path) -> Any:
    workspace = temp_dir / "workspace"
    workspace.mkdir(exist_ok=True)
    path = workspace / "output.txt"
    return write_file(
        content="hello world",
        file_path=str(path),
        caller="direct",
        agent_config=type("Cfg", (), {"custom_params": {"workspace_root": str(workspace)}})(),
    )


def _sample_read_file(temp_dir: Path) -> Any:
    workspace = temp_dir / "workspace"
    workspace.mkdir(exist_ok=True)
    path = workspace / "sample.txt"
    path.write_text("hello world", encoding="utf-8")
    return read_file(
        file_path=str(path),
        caller="direct",
        agent_config=type("Cfg", (), {"custom_params": {"workspace_root": str(workspace)}})(),
    )


def _sample_preview_data_structure(temp_dir: Path) -> Any:
    workspace = temp_dir / "workspace"
    workspace.mkdir(exist_ok=True)
    path = workspace / "sample.json"
    path.write_text('{"items": [{"id": 1, "name": "Alice"}]}', encoding="utf-8")
    return preview_data_structure(
        file_path=str(path),
        caller="direct",
        agent_config=type("Cfg", (), {"custom_params": {"workspace_root": str(workspace)}})(),
    )


def _sample_assess_flood_risk(_: Path) -> Any:
    return TOOL_HANDLERS["execute_skill_script"](
        skill_name="emergency-decision-support",
        script_name="assess_flood_risk.py",
        arguments=[
            "--location", "南宁市",
            "--rainfall", "150",
            "--water-level", "78.5",
            "--warning-level", "77.0",
        ],
    )


def _sample_match_emergency_response(_: Path) -> Any:
    return TOOL_HANDLERS["execute_skill_script"](
        skill_name="emergency-decision-support",
        script_name="match_response.py",
        arguments=[
            "--risk-level", "III",
            "--disaster-type", "洪涝",
            "--affected-area", "南宁市",
        ],
    )


def _sample_create_risk_map(_: Path) -> Any:
    return TOOL_HANDLERS["execute_skill_script"](
        skill_name="emergency-decision-support",
        script_name="create_risk_map.py",
        arguments=[
            "--data", '[{"location":"南宁市","geometry":"POINT (108.366 22.817)","rainfall_24h":150,"water_level":78.5,"warning_level":77.0}]',
            "--title", "风险地图",
            "--disaster-type", "洪涝",
        ],
        session_id="audit-session",
    )


def _sample_create_bindmap(_: Path) -> Any:
    return TOOL_HANDLERS["execute_skill_script"](
        skill_name="visualization",
        script_name="create_bindmap.py",
        arguments=[
            "--layers", '[{"data":"[{\"name\":\"A\",\"value\":1,\"geometry\":\"POINT (121.47 31.23)\"}]","map_type":"marker","label":"points","name_field":"name","value_field":"value","geometry_field":"geometry"}]',
            "--title", "bindmap",
        ],
        session_id="audit-session",
    )


def _sample_execute_bash(temp_dir: Path) -> Any:
    workspace = temp_dir / "workspace"
    workspace.mkdir(exist_ok=True)
    return TOOL_HANDLERS["execute_bash"](
        command="pwd",
        session_id="audit-session",
        agent_config=type("Cfg", (), {"custom_params": {"workspace_root": str(workspace)}})(),
    )


def _sample_generate_report(_: Path) -> Any:
    return TOOL_HANDLERS["generate_report"](
        report_type="situation_report",
        title="南宁市防汛综合态势报告",
        location="南宁市",
        situation_data={"summary": "全市出现持续强降雨"},
        risk_data={"risk_level": "III", "risk_label": "较大", "assessment": "需加强巡查"},
        warning_data={"warnings": [{"title": "暴雨橙色预警"}]},
        plan_data={"matched_plans": ["启动城区内涝防御预案"]},
        action_data={"key_actions": ["预置抢险力量"]},
        weather_data={"rainfall_24h_mm": 86},
    )


def _sample_edit_file(temp_dir: Path) -> Any:
    workspace = temp_dir / "workspace"
    workspace.mkdir(exist_ok=True)
    path = workspace / "edit.txt"
    path.write_text("before\nafter\n", encoding="utf-8")
    return edit_file(
        file_path=str(path),
        old_string="before",
        new_string="updated",
        caller="direct",
        agent_config=type("Cfg", (), {"custom_params": {"workspace_root": str(workspace)}})(),
    )


_SAMPLE_RUNNERS: Dict[str, Callable[[Path], Any]] = {
    "execute_bash": _sample_execute_bash,
    "generate_report": _sample_generate_report,
    "activate_skill": lambda temp_dir: _run_skill_sample("activate_skill", temp_dir),
    "load_skill_resource": lambda temp_dir: _run_skill_sample("load_skill_resource", temp_dir),
    "execute_skill_script": lambda temp_dir: _run_skill_sample("execute_skill_script", temp_dir),
    "get_skill_info": lambda temp_dir: _run_skill_sample("get_skill_info", temp_dir),
    "write_file": _sample_write_file,
    "read_file": _sample_read_file,
    "preview_data_structure": _sample_preview_data_structure,
    "edit_file": _sample_edit_file,
}


def _registered_tool_names() -> List[str]:
    registry = get_tool_registry()
    return sorted(
        tool["function"]["name"]
        for tool in registry.get_base_tools()
        if tool["function"]["name"] not in _DYNAMIC_TOOL_NAMES
    )


def _tool_category(tool_name: str) -> str:
    return get_tool_registry().get_tool_category(tool_name)


def _tool_source(tool_name: str) -> str:
    tool = get_tool_registry().get_tool_by_name(tool_name)
    if tool and tool.get("function", {}).get("source") == "document":
        return "tools/document_executor.py"
    if tool_name in TOOL_HANDLERS:
        source = inspect.getsourcefile(TOOL_HANDLERS[tool_name])
        if source:
            return str(Path(source).resolve().relative_to(ROOT_DIR)).replace("\\", "/")
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
